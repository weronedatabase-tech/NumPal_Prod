// ==========================================
// backend/Code.js - Google Apps Script Backend for NumPal AI Expiry Scanner
// Handles AI expiry date scanning when the frontend is hosted on static hosting
// such as GitHub Pages (which cannot execute Node.js POST routes).
//
// Required Script Property (Apps Script > Project Settings > Script Properties):
//   GEMINI_API_KEY      = Your Gemini API key
// Optional Script Property:
//   GEMINI_FLASH_MODEL  = Gemini model ID override (default: gemini-4-hydrogen)
// ==========================================

const DEFAULT_GEMINI_FLASH_MODEL = 'gemini-4-hydrogen';

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
  return { apiKey, model };
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
    configured: Boolean(cfg.apiKey)
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

    if (/^gemini-[34]/.test(cfg.model)) {
      generationConfig.thinkingConfig = { thinkingLevel: 'LOW' };
    }

    const requestPayload = {
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

    const apiResponse = callGeminiWithRetry(cfg.model, cfg.apiKey, requestPayload, 2);
    const statusCode = apiResponse.getResponseCode();
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
          error: 'AI scan rate limit reached. Please wait a moment or use Scan Offline.',
          upstreamStatus: statusCode
        });
      }
      if (statusCode === 404 || /NOT_FOUND/i.test(upstreamMsg)) {
        return jsonOutput({
          ok: false,
          error: 'Configured Gemini model (' + cfg.model + ') was not found. Update GEMINI_FLASH_MODEL in Script Properties.',
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
      parsed = JSON.parse(rawText);
    } catch (_parseErr) {
      return jsonOutput({ ok: false, error: 'AI returned an unreadable response. Please try again.' });
    }

    const durationMs = Date.now() - startTime;

    if (!parsed || !parsed.foundDate) {
      return jsonOutput({
        foundDate: false,
        reason: (parsed && parsed.reason) || 'no_date',
        matchedText: (parsed && parsed.matchedText) || '',
        model: cfg.model,
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
        model: cfg.model,
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
        model: cfg.model,
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
      model: cfg.model,
      durationMs: durationMs
    });
  } catch (error) {
    return jsonOutput({
      ok: false,
      error: 'AI scan failed on backend: ' + sanitizeErrorDetail(error && error.message ? error.message : error)
    });
  }
}