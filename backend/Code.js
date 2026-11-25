// ==========================================
// backend/Code.js - Google Apps Script Backend for NumPal AI Expiry Scanner
// Handles AI expiry date scanning and admin AI model management when the frontend
// is hosted on static hosting such as GitHub Pages.
//
// Required Script Properties (Apps Script > Project Settings > Script Properties):
//   GEMINI_API_KEY         = Your Gemini API key
//   AI_Model_Change        = Admin password for the hidden AI Model Settings screen
// Optional Script Properties:
//   GEMINI_FLASH_MODEL     = Main AI Model ID (default: gemini-4-hydrogen)
//   GEMINI_FALLBACK_MODEL  = Backup AI Model ID on 429/503 (default: gemini-3.1-flash-lite)
// ==========================================

const DEFAULT_GEMINI_FLASH_MODEL = 'gemini-4-hydrogen';
const DEFAULT_GEMINI_FALLBACK_MODEL = 'gemini-3.1-flash-lite';
const ADMIN_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes
const ADMIN_MAX_FAILED_ATTEMPTS = 10;
const ADMIN_LOCKOUT_SECONDS = 600; // 10 minutes
const MODEL_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,99}$/;

const ALLOWED_IMAGE_MIME_TYPES = {
  'image/jpeg': true,
  'image/png': true,
  'image/webp': true,
  'image/heic': true,
  'image/heif': true
};

function jsonOutput(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function daysInMonth(year, month1Based) {
  return new Date(year, month1Based, 0).getDate();
}

function getScriptConfig() {
  const props = PropertiesService.getScriptProperties();
  const apiKey = String(props.getProperty('GEMINI_API_KEY') || '').trim();
  const model = String(props.getProperty('GEMINI_FLASH_MODEL') || DEFAULT_GEMINI_FLASH_MODEL).trim();
  const fallbackModel = String(
    props.getProperty('GEMINI_FALLBACK_MODEL') || DEFAULT_GEMINI_FALLBACK_MODEL
  ).trim();
  const adminPassword = String(props.getProperty('AI_Model_Change') || '');
  return { apiKey, model, fallbackModel, adminPassword };
}

function isRetryableStatus(statusCode) {
  return (
    statusCode === 429 ||
    statusCode === 500 ||
    statusCode === 502 ||
    statusCode === 503 ||
    statusCode === 504
  );
}

function sanitizeErrorDetail(msg) {
  return String(msg || '')
    .replace(/AIza[0-9A-Za-z\-_]+/g, '[redacted]')
    .slice(0, 240);
}

function constantTimeEquals(a, b) {
  const strA = String(a || '');
  const strB = String(b || '');
  const maxLen = Math.max(strA.length, strB.length);
  let diff = strA.length ^ strB.length;
  for (let i = 0; i < maxLen; i++) {
    const codeA = i < strA.length ? strA.charCodeAt(i) : 0;
    const codeB = i < strB.length ? strB.charCodeAt(i) : 0;
    diff |= codeA ^ codeB;
  }
  return diff === 0;
}

function getOrCreateTokenSigningKey(adminPassword) {
  const props = PropertiesService.getScriptProperties();
  let secret = String(props.getProperty('ADMIN_TOKEN_SECRET') || '').trim();
  if (!secret) {
    secret = Utilities.getUuid() + '-' + Utilities.getUuid();
    props.setProperty('ADMIN_TOKEN_SECRET', secret);
  }
  return secret + ':' + adminPassword;
}

function signAdminToken(adminPassword) {
  const payload = String(Date.now() + ADMIN_TOKEN_TTL_MS) + '.' + Utilities.getUuid().replace(/-/g, '');
  const sigBytes = Utilities.computeHmacSha256Signature(
    payload,
    getOrCreateTokenSigningKey(adminPassword),
    Utilities.Charset.UTF_8
  );
  const sig = Utilities.base64EncodeWebSafe(sigBytes);
  return payload + '.' + sig;
}

function verifyAdminToken(token, adminPassword) {
  if (!token || typeof token !== 'string' || !adminPassword) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;

  const expiresAt = Number(parts[0]);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
    return false;
  }

  const payload = parts[0] + '.' + parts[1];
  const expectedBytes = Utilities.computeHmacSha256Signature(
    payload,
    getOrCreateTokenSigningKey(adminPassword),
    Utilities.Charset.UTF_8
  );
  const expectedSig = Utilities.base64EncodeWebSafe(expectedBytes);
  return constantTimeEquals(parts[2], expectedSig);
}

function checkAdminRateLimit() {
  try {
    const cache = CacheService.getScriptCache();
    const count = Number(cache.get('admin_auth_fails') || '0');
    return count >= ADMIN_MAX_FAILED_ATTEMPTS;
  } catch (_err) {
    return false;
  }
}

function recordAdminAuthFailure() {
  try {
    const cache = CacheService.getScriptCache();
    const count = Number(cache.get('admin_auth_fails') || '0') + 1;
    cache.put('admin_auth_fails', String(count), ADMIN_LOCKOUT_SECONDS);
  } catch (_err) {
    // Ignore cache quota errors
  }
}

function clearAdminAuthFailures() {
  try {
    CacheService.getScriptCache().remove('admin_auth_fails');
  } catch (_err) {
    // Ignore cache errors
  }
}

// ==========================================
// Live Google Free Gemini / Gemma Model Catalog
// ==========================================
function isEligibleFreeExpiryModel(rawModel) {
  if (!rawModel || typeof rawModel.name !== 'string') return false;
  const methods = Array.isArray(rawModel.supportedGenerationMethods)
    ? rawModel.supportedGenerationMethods
    : [];
  if (methods.indexOf('generateContent') === -1) return false;

  const id = rawModel.name.replace(/^models\//i, '').trim();
  const lower = id.toLowerCase();

  const isGemini = lower.indexOf('gemini-') === 0;
  const isGemma = lower.indexOf('gemma-') === 0;
  if (!isGemini && !isGemma) return false;

  // Exclude non-scanning / specialized modalities (audio, TTS, image gen, video, embeddings, robotics, etc.)
  if (
    /(embedding|tts|transcribe|translate|live|audio|image|imagen|nano-banana|veo|lyria|omni|genie|decision|robotics|computer-use|deep-research|aqa|customtools|bisociative)/i.test(
      lower
    )
  ) {
    return false;
  }

  if (isGemini) {
    // Exclude deprecated 1.x / 2.0 models
    if (/^gemini-(1\.0|1\.5|2\.0|pro\b)/i.test(lower)) return false;

    // Exclude paid-only tiers (Pro, Ultra, Neon, Carbon, Argon)
    if (/(^|[-_])(pro|ultra|neon|carbon|argon)($|[-_])/i.test(lower)) return false;

    // Keep free-tier Flash / Flash-Lite / Hydrogen models
    return /(flash|hydrogen)/i.test(lower);
  }

  if (isGemma) {
    // Exclude text-only Gemma variants (Gemma 1/2, Gemma 3 1B, Gemma 3n) that do not support image input
    if (/^gemma-(1|2)\b/i.test(lower)) return false;
    if (/^gemma-3-1b\b/i.test(lower)) return false;
    if (/^gemma-3n\b/i.test(lower)) return false;

    // Keep multimodal Gemma 3 (4B/12B/27B) and Gemma 4+ models
    return /^gemma-([3-9]|[1-9]\d)/i.test(lower);
  }

  return false;
}

function getModelSortWeight(modelObj) {
  const lower = modelObj.id.toLowerCase();
  const isGemma = modelObj.family === 'gemma';
  const familyWeight = isGemma ? 1 : 0;

  let versionScore = 0;
  const verMatch = lower.match(/^(?:gemini|gemma)-(\d+(?:\.\d+)?)/);
  if (verMatch) {
    versionScore = parseFloat(verMatch[1]) || 0;
  } else if (lower.indexOf('-latest') !== -1) {
    versionScore = 2.0;
  }

  let sizeScore = 0;
  const sizeMatch = lower.match(/(\d+)b\b/);
  if (sizeMatch) {
    sizeScore = parseInt(sizeMatch[1], 10) || 0;
  }

  const isLite = /lite/i.test(lower) ? 1 : 0;
  const isPreview = /(preview|exp)/i.test(lower) ? 1 : 0;
  const isDated = /\d{2}-\d{4}|\d{4}-\d{2}/.test(lower) ? 1 : 0;

  return { familyWeight, versionScore, sizeScore, isLite, isPreview, isDated };
}

function fetchLiveFreeModels(apiKey) {
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set in Google Apps Script Script Properties.');
  }

  const allModels = [];
  let pageToken = '';
  let pageCount = 0;

  do {
    let url = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=100';
    if (pageToken) {
      url += '&pageToken=' + encodeURIComponent(pageToken);
    }

    const res = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: {
        'x-goog-api-key': apiKey
      },
      muteHttpExceptions: true
    });

    const code = res.getResponseCode();
    const text = res.getContentText() || '';
    if (code < 200 || code >= 300) {
      let errMsg = text;
      try {
        const parsedErr = JSON.parse(text);
        if (parsedErr && parsedErr.error && parsedErr.error.message) {
          errMsg = parsedErr.error.message;
        }
      } catch (_ignored) {}
      throw new Error('Could not fetch Google models (' + code + '): ' + sanitizeErrorDetail(errMsg));
    }

    const data = JSON.parse(text);
    const items = Array.isArray(data.models) ? data.models : [];
    for (let i = 0; i < items.length; i++) {
      allModels.push(items[i]);
    }
    pageToken = data.nextPageToken || '';
    pageCount++;
  } while (pageToken && pageCount < 5);

  const seen = {};
  const filtered = [];
  for (let i = 0; i < allModels.length; i++) {
    const raw = allModels[i];
    if (!isEligibleFreeExpiryModel(raw)) continue;
    const id = raw.name.replace(/^models\//i, '').trim();
    if (!id || seen[id]) continue;
    seen[id] = true;

    const family = id.toLowerCase().indexOf('gemma-') === 0 ? 'gemma' : 'gemini';
    filtered.push({
      id: id,
      displayName: String(raw.displayName || id).trim(),
      family: family
    });
  }

  filtered.sort(function (a, b) {
    const wa = getModelSortWeight(a);
    const wb = getModelSortWeight(b);
    if (wa.familyWeight !== wb.familyWeight) return wa.familyWeight - wb.familyWeight;
    if (wa.versionScore !== wb.versionScore) return wb.versionScore - wa.versionScore;
    if (wa.sizeScore !== wb.sizeScore) return wb.sizeScore - wa.sizeScore;
    if (wa.isLite !== wb.isLite) return wa.isLite - wb.isLite;
    if (wa.isPreview !== wb.isPreview) return wa.isPreview - wb.isPreview;
    if (wa.isDated !== wb.isDated) return wa.isDated - wb.isDated;
    return a.id.localeCompare(b.id);
  });

  return filtered;
}

// ==========================================
// Admin Action Handlers
// ==========================================
function handleAdminAuth(body) {
  const cfg = getScriptConfig();
  if (!cfg.adminPassword) {
    return jsonOutput({
      ok: false,
      error: 'Admin password (AI_Model_Change) is not set in Google Apps Script Script Properties.'
    });
  }

  if (checkAdminRateLimit()) {
    return jsonOutput({
      ok: false,
      error: 'Too many failed password attempts. Please wait a few minutes and try again.'
    });
  }

  const candidate = typeof body.password === 'string' ? body.password : '';
  if (!candidate || !constantTimeEquals(candidate, cfg.adminPassword)) {
    recordAdminAuthFailure();
    return jsonOutput({
      ok: false,
      error: 'Incorrect password. Please try again.'
    });
  }

  clearAdminAuthFailures();

  let models;
  try {
    models = fetchLiveFreeModels(cfg.apiKey);
  } catch (err) {
    return jsonOutput({
      ok: false,
      error: sanitizeErrorDetail(err && err.message ? err.message : 'Failed to load models from Google.')
    });
  }

  return jsonOutput({
    ok: true,
    adminToken: signAdminToken(cfg.adminPassword),
    currentMainModel: cfg.model,
    currentBackupModel: cfg.fallbackModel,
    models: models
  });
}

function handleAdminRefreshModels(body) {
  const cfg = getScriptConfig();
  if (!cfg.adminPassword || !verifyAdminToken(body.adminToken, cfg.adminPassword)) {
    return jsonOutput({
      ok: false,
      authExpired: true,
      error: 'Session expired. Please re-enter the admin password.'
    });
  }

  try {
    const models = fetchLiveFreeModels(cfg.apiKey);
    return jsonOutput({
      ok: true,
      currentMainModel: cfg.model,
      currentBackupModel: cfg.fallbackModel,
      models: models
    });
  } catch (err) {
    return jsonOutput({
      ok: false,
      error: sanitizeErrorDetail(err && err.message ? err.message : 'Failed to refresh models from Google.')
    });
  }
}

function handleAdminUpdateModels(body) {
  const cfg = getScriptConfig();
  if (!cfg.adminPassword || !verifyAdminToken(body.adminToken, cfg.adminPassword)) {
    return jsonOutput({
      ok: false,
      authExpired: true,
      error: 'Session expired. Please re-enter the admin password.'
    });
  }

  const mainModel = typeof body.mainModel === 'string' ? body.mainModel.trim() : '';
  const backupModel = typeof body.backupModel === 'string' ? body.backupModel.trim() : '';

  if (!MODEL_ID_REGEX.test(mainModel) || !MODEL_ID_REGEX.test(backupModel)) {
    return jsonOutput({
      ok: false,
      error: 'Please select valid Main and Backup AI models.'
    });
  }

  // Verify selected models against live free catalog (allowing keeping currently active values unchanged)
  try {
    const liveModels = fetchLiveFreeModels(cfg.apiKey);
    const allowedSet = {};
    for (let i = 0; i < liveModels.length; i++) {
      allowedSet[liveModels[i].id] = true;
    }
    if (cfg.model) allowedSet[cfg.model] = true;
    if (cfg.fallbackModel) allowedSet[cfg.fallbackModel] = true;

    if (!allowedSet[mainModel] || !allowedSet[backupModel]) {
      return jsonOutput({
        ok: false,
        error: 'Selected model is not in the live free Gemini/Gemma model list.'
      });
    }
  } catch (err) {
    return jsonOutput({
      ok: false,
      error: sanitizeErrorDetail(err && err.message ? err.message : 'Could not validate models against Google API.')
    });
  }

  PropertiesService.getScriptProperties().setProperties({
    GEMINI_FLASH_MODEL: mainModel,
    GEMINI_FALLBACK_MODEL: backupModel
  });

  return jsonOutput({
    ok: true,
    mainModel: mainModel,
    backupModel: backupModel
  });
}

// ==========================================
// Expiry Date Scanner Helpers
// ==========================================
function parseModelJsonResponse(rawText) {
  const trimmed = String(rawText || '').trim();
  if (!trimmed) {
    throw new Error('Empty model response');
  }
  try {
    return JSON.parse(trimmed);
  } catch (_directErr) {
    const fenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    try {
      return JSON.parse(fenced);
    } catch (_fenceErr) {
      const start = fenced.indexOf('{');
      const end = fenced.lastIndexOf('}');
      if (start !== -1 && end > start) {
        return JSON.parse(fenced.slice(start, end + 1));
      }
      throw _fenceErr;
    }
  }
}

function callGeminiWithRetry(model, apiKey, payload, maxRetries) {
  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(model) +
    ':generateContent';

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-goog-api-key': apiKey
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  let lastResponse = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    lastResponse = UrlFetchApp.fetch(url, options);
    const code = lastResponse.getResponseCode();
    if (code >= 200 && code < 300) {
      return lastResponse;
    }
    if (attempt < maxRetries && isRetryableStatus(code)) {
      Utilities.sleep(400 * Math.pow(2, attempt));
      continue;
    }
    return lastResponse;
  }
  return lastResponse;
}

// Health check endpoint (open the /exec URL in a browser to verify deployment & key status)
function doGet() {
  const cfg = getScriptConfig();
  return jsonOutput({
    ok: true,
    service: 'NumPal Expiry AI Scanner',
    model: cfg.model,
    fallbackModel: cfg.fallbackModel || null,
    configured: Boolean(cfg.apiKey),
    adminConfigured: Boolean(cfg.adminPassword)
  });
}

function doPost(e) {
  const startTime = Date.now();

  try {
    if (!e || !e.postData || typeof e.postData.contents !== 'string' || !e.postData.contents.trim()) {
      return jsonOutput({ ok: false, error: 'Missing request body.' });
    }

    let body;
    try {
      body = JSON.parse(e.postData.contents);
    } catch (_parseErr) {
      return jsonOutput({ ok: false, error: 'Invalid JSON payload.' });
    }

    // Route admin model-selection actions
    if (body && body.action === 'admin_auth') {
      return handleAdminAuth(body);
    }
    if (body && body.action === 'admin_refresh_models') {
      return handleAdminRefreshModels(body);
    }
    if (body && body.action === 'admin_update_models') {
      return handleAdminUpdateModels(body);
    }

    const rawInput =
      typeof body.imageBase64 === 'string' && body.imageBase64.trim()
        ? body.imageBase64.trim()
        : typeof body.image === 'string' && body.image.trim()
          ? body.image.trim()
          : '';

    if (!rawInput) {
      return jsonOutput({ ok: false, error: 'Missing image data.' });
    }

    let rawBase64 = rawInput;
    let detectedMimeType = typeof body.mimeType === 'string' ? body.mimeType.trim().toLowerCase() : '';

    const dataUrlMatch = rawBase64.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
    if (dataUrlMatch) {
      if (!detectedMimeType) {
        detectedMimeType = dataUrlMatch[1].toLowerCase();
      }
      rawBase64 = dataUrlMatch[2];
    }

    const mimeType = ALLOWED_IMAGE_MIME_TYPES[detectedMimeType] ? detectedMimeType : 'image/jpeg';

    if (rawBase64.length > 10 * 1024 * 1024) {
      return jsonOutput({ ok: false, error: 'Image is too large. Please try a closer photo.' });
    }

    const cfg = getScriptConfig();
    if (!cfg.apiKey) {
      return jsonOutput({
        ok: false,
        error: 'GEMINI_API_KEY is not set in Google Apps Script Project Settings > Script Properties.'
      });
    }

    let refDate = new Date();
    if (typeof body.todayIso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.todayIso)) {
      const partsIso = body.todayIso.split('-');
      const parsedRef = new Date(Number(partsIso[0]), Number(partsIso[1]) - 1, Number(partsIso[2]));
      if (!isNaN(parsedRef.getTime())) {
        refDate = parsedRef;
      }
    }
    const refYear = refDate.getFullYear();

    const systemInstruction = [
      'You read product packaging photos to extract the EXPIRATION DATE (also labeled EXP, EXPIRY, BEST BEFORE, BBE, BB, USE BY, USE BEFORE, CONSUME BY, SELL BY, VALID UNTIL).',
      'Ignore manufacturing, production, packed, or lot dates (MFG, MFD, PROD, PKD, DOM, LOT, BATCH).',
      'If BOTH a manufacturing date and an expiration date appear, ALWAYS return the expiration date (the later date).',
      'If ONLY a manufacturing/production date is visible and no expiration date exists, return foundDate: false with reason: "only_mfg_found".',
      'If no date is clearly legible, return foundDate: false with reason: "no_date" or "illegible". Never guess or invent a date.',
      'Pay close attention to dot-matrix, inkjet, embossed, and low-contrast dates.',
      'Regional format: Default to DD/MM/YYYY or DD/MM/YY (Singapore/UK standard) when day vs month is ambiguous (e.g., 05/08/26 = 5 August 2026), unless the format is clearly YYYY/MM/DD or the second number exceeds 12 (MM/DD/YYYY).',
      'Expand 2-digit years relative to the current year (' + refYear + '), e.g. 26 -> 2026.',
      'If only month and year are printed (e.g. NOV 2026 or 11/2026), set isMonthOnly: true and day: 0.'
    ].join(' ');

    const promptText =
      'Inspect this product image and extract the expiration date. Today\'s reference year is ' +
      refYear +
      '. Return structured JSON only.';

    function buildRequestPayload(modelName) {
      const isGemma = /^gemma-/i.test(modelName);

      // Gemma models do not support systemInstruction or responseSchema JSON mode
      if (isGemma) {
        const combinedPrompt =
          systemInstruction +
          '\n\n' +
          promptText +
          '\nRespond with ONLY a raw JSON object (no markdown fences or extra text) matching this exact structure: ' +
          '{"foundDate": boolean, "year": integer (4-digit or 0), "month": integer (1-12 or 0), "day": integer (1-31 or 0), "isMonthOnly": boolean, "matchedText": string, "reason": "ok"|"no_date"|"only_mfg_found"|"illegible"}';

        return {
          contents: [
            {
              role: 'user',
              parts: [
                {
                  inlineData: {
                    mimeType: mimeType,
                    data: rawBase64
                  }
                },
                {
                  text: combinedPrompt
                }
              ]
            }
          ]
        };
      }

      const generationConfig = {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            foundDate: {
              type: 'BOOLEAN',
              description: 'True if an expiration / best-before / use-by date is clearly legible.'
            },
            year: {
              type: 'INTEGER',
              description: '4-digit year (e.g. 2026) or 0 if not found.'
            },
            month: {
              type: 'INTEGER',
              description: 'Month number 1-12 or 0 if not found.'
            },
            day: {
              type: 'INTEGER',
              description: 'Day of month 1-31, or 0 if only month & year are printed or not found.'
            },
            isMonthOnly: {
              type: 'BOOLEAN',
              description: 'True if only month and year are printed without a day.'
            },
            matchedText: {
              type: 'STRING',
              description: 'Exact date string read from the image.'
            },
            reason: {
              type: 'STRING',
              description: 'Short status: ok, no_date, only_mfg_found, or illegible.'
            }
          },
          required: ['foundDate', 'year', 'month', 'day', 'isMonthOnly', 'matchedText', 'reason']
        }
      };

      if (/^gemini-[34]/.test(modelName) && !/flash-lite/i.test(modelName)) {
        generationConfig.thinkingConfig = { thinkingLevel: 'LOW' };
      }

      return {
        systemInstruction: {
          parts: [{ text: systemInstruction }]
        },
        contents: [
          {
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType: mimeType,
                  data: rawBase64
                }
              },
              {
                text: promptText
              }
            ]
          }
        ],
        generationConfig: generationConfig
      };
    }

    let usedModel = cfg.model;
    let apiResponse = callGeminiWithRetry(usedModel, cfg.apiKey, buildRequestPayload(usedModel), 2);
    let statusCode = apiResponse.getResponseCode();

    if (
      (statusCode === 429 || statusCode === 503) &&
      cfg.fallbackModel &&
      cfg.fallbackModel !== usedModel
    ) {
      usedModel = cfg.fallbackModel;
      apiResponse = callGeminiWithRetry(usedModel, cfg.apiKey, buildRequestPayload(usedModel), 1);
      statusCode = apiResponse.getResponseCode();
    }

    const resText = apiResponse.getContentText() || '';

    if (statusCode < 200 || statusCode >= 300) {
      let upstreamMsg = resText;
      try {
        const errJson = JSON.parse(resText);
        if (errJson && errJson.error && errJson.error.message) {
          upstreamMsg = errJson.error.message;
        }
      } catch (_ignored) {}

      if (statusCode === 400 || statusCode === 403 || /API_KEY_INVALID|PERMISSION_DENIED/i.test(upstreamMsg)) {
        return jsonOutput({
          ok: false,
          error: 'Gemini API key error. Verify GEMINI_API_KEY in Google Apps Script Script Properties.',
          upstreamStatus: statusCode
        });
      }
      if (statusCode === 429 || /RESOURCE_EXHAUSTED/i.test(upstreamMsg)) {
        return jsonOutput({
          ok: false,
          error: 'AI scan quota reached. Check billing on your GEMINI_API_KEY project, or use Scan Offline.',
          upstreamStatus: statusCode
        });
      }
      if (statusCode === 404 || /NOT_FOUND/i.test(upstreamMsg)) {
        return jsonOutput({
          ok: false,
          error: 'Configured Gemini model (' + usedModel + ') was not found. Update GEMINI_FLASH_MODEL in Script Properties.',
          upstreamStatus: statusCode
        });
      }

      return jsonOutput({
        ok: false,
        error: 'AI scan failed. Please check your connection or try Scan Offline.',
        upstreamStatus: statusCode,
        detail: sanitizeErrorDetail(upstreamMsg)
      });
    }

    let apiJson;
    try {
      apiJson = JSON.parse(resText);
    } catch (_jsonErr) {
      return jsonOutput({ ok: false, error: 'AI returned an unreadable response. Please try again.' });
    }

    const parts =
      (apiJson &&
        apiJson.candidates &&
        apiJson.candidates[0] &&
        apiJson.candidates[0].content &&
        apiJson.candidates[0].content.parts) ||
      [];

    let rawText = '';
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] && typeof parts[i].text === 'string' && !parts[i].thought) {
        rawText += parts[i].text;
      }
    }
    rawText = rawText.trim();

    let parsed;
    try {
      parsed = parseModelJsonResponse(rawText);
    } catch (_parseErr) {
      return jsonOutput({ ok: false, error: 'AI returned an unreadable response. Please try again.' });
    }

    const durationMs = Date.now() - startTime;

    if (!parsed || !parsed.foundDate) {
      return jsonOutput({
        foundDate: false,
        reason: (parsed && parsed.reason) || 'no_date',
        matchedText: (parsed && parsed.matchedText) || '',
        model: usedModel,
        durationMs: durationMs
      });
    }

    const year = Number(parsed.year);
    const month = Number(parsed.month);
    const isMonthOnly = Boolean(parsed.isMonthOnly) || Number(parsed.day) === 0;
    const minYear = refYear - 10;
    const maxYear = refYear + 15;

    if (
      !Number.isInteger(year) ||
      year < minYear ||
      year > maxYear ||
      !Number.isInteger(month) ||
      month < 1 ||
      month > 12
    ) {
      return jsonOutput({
        foundDate: false,
        reason: 'invalid_date',
        matchedText: String(parsed.matchedText || ''),
        model: usedModel,
        durationMs: durationMs
      });
    }

    const maxDay = daysInMonth(year, month);
    const day = isMonthOnly ? maxDay : Number(parsed.day);

    if (!Number.isInteger(day) || day < 1 || day > maxDay) {
      return jsonOutput({
        foundDate: false,
        reason: 'invalid_day',
        matchedText: String(parsed.matchedText || ''),
        model: usedModel,
        durationMs: durationMs
      });
    }

    return jsonOutput({
      foundDate: true,
      year: year,
      month: month,
      day: day,
      isMonthOnly: isMonthOnly,
      matchedText: String(parsed.matchedText || ''),
      reason: 'ok',
      model: usedModel,
      durationMs: durationMs
    });
  } catch (error) {
    return jsonOutput({
      ok: false,
      error: 'AI scan failed on backend: ' + sanitizeErrorDetail(error && error.message ? error.message : error)
    });
  }
}