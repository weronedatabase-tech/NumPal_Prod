const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { GoogleGenAI, Type, ThinkingLevel } = require('@google/genai');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const ROOT_DIR = __dirname;

// Active free-tier Gemini Flash model (overrideable via GEMINI_FLASH_MODEL env var without code changes)
const GEMINI_FLASH_MODEL = (process.env.GEMINI_FLASH_MODEL || 'gemini-4-hydrogen').trim();

const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif'
]);

const TRACKED_APP_FILES = [
  'index.html',
  'manifest.json',
  'sw.js',
  'version.json',
  'frontend/css/styles.css',
  'frontend/js/core/config.js',
  'frontend/js/core/app.js',
  'frontend/js/utils/ui.js',
  'frontend/js/utils/rolodex.js',
  'frontend/js/utils/date-parser.js',
  'frontend/js/workers/ocr.worker.js',
  'frontend/js/pages/duration.js',
  'frontend/js/pages/end-time.js',
  'frontend/js/pages/expiry.js',
  'frontend/js/pages/purchasing2.js',
  'frontend/js/pages/stopwatch.js',
  'frontend/pages/duration.html',
  'frontend/pages/end-time.html',
  'frontend/pages/expiry.html',
  'frontend/pages/purchasing2.html',
  'frontend/pages/stopwatch.html',
  'frontend/pages/time-menu.html'
];

let cachedGenAiClient = null;
let cachedApiKey = null;

function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    return null;
  }
  if (!cachedGenAiClient || cachedApiKey !== apiKey) {
    cachedGenAiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build'
        }
      }
    });
    cachedApiKey = apiKey;
  }
  return cachedGenAiClient;
}

function daysInMonth(year, month1Based) {
  return new Date(year, month1Based, 0).getDate();
}

function isRetryableGeminiError(err) {
  const status = err && (err.status || err.statusCode || (err.error && err.error.code));
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  const msg = String((err && err.message) || '');
  return /ECONNRESET|ETIMEDOUT|ENOTFOUND|network|unavailable|503|500/i.test(msg);
}

async function generateWithRetry(ai, params, maxRetries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await ai.models.generateContent(params);
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries && isRetryableGeminiError(err)) {
        const delayMs = 400 * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

function computeAppBuildHash() {
  const hash = crypto.createHash('sha256');
  for (const relPath of TRACKED_APP_FILES) {
    const absPath = path.join(ROOT_DIR, relPath);
    try {
      const content = fs.readFileSync(absPath);
      hash.update(relPath);
      hash.update('\0');
      hash.update(content);
      hash.update('\0');
    } catch (_err) {
      // Skip missing optional files cleanly
    }
  }
  return hash.digest('hex').slice(0, 16);
}

function readStaticVersionMetadata() {
  try {
    const raw = fs.readFileSync(path.join(ROOT_DIR, 'version.json'), 'utf8');
    return JSON.parse(raw);
  } catch (_err) {
    return { name: 'NumPal', version: '1.1.0', cacheVersion: 'v109' };
  }
}

app.use(express.json({ limit: '10mb' }));

// Server-side Gemini Flash expiry date scanning endpoint
app.post('/api/scan-expiry', async (req, res) => {
  const startTime = Date.now();
  const body = req.body || {};

  if (typeof body.imageBase64 !== 'string' || !body.imageBase64.trim()) {
    return res.status(400).json({ error: 'Missing image data.' });
  }

  let rawBase64 = body.imageBase64.trim();
  let detectedMimeType = typeof body.mimeType === 'string' ? body.mimeType.trim().toLowerCase() : '';

  const dataUrlMatch = rawBase64.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (dataUrlMatch) {
    if (!detectedMimeType) {
      detectedMimeType = dataUrlMatch[1].toLowerCase();
    }
    rawBase64 = dataUrlMatch[2];
  }

  const mimeType = ALLOWED_IMAGE_MIME_TYPES.has(detectedMimeType) ? detectedMimeType : 'image/jpeg';

  // Basic base64 sanity & size guard (~7.5 MB decoded)
  if (rawBase64.length > 10 * 1024 * 1024) {
    return res.status(413).json({ error: 'Image is too large. Please try a closer photo.' });
  }

  const ai = getGeminiClient();
  if (!ai) {
    return res.status(503).json({
      error: 'Gemini API key is not configured on the server. Check Settings > Secrets.'
    });
  }

  // Determine reference year for 2-digit year disambiguation
  let refDate = new Date();
  if (typeof body.todayIso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.todayIso)) {
    const parsedRef = new Date(`${body.todayIso}T00:00:00`);
    if (!Number.isNaN(parsedRef.getTime())) {
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
    `Expand 2-digit years relative to the current year (${refYear}), e.g. 26 -> 2026.`,
    'If only month and year are printed (e.g. NOV 2026 or 11/2026), set isMonthOnly: true and day: 0.'
  ].join(' ');

  const promptText = `Inspect this product image and extract the expiration date. Today's reference year is ${refYear}. Return structured JSON only.`;

  try {
    const response = await generateWithRetry(ai, {
      model: GEMINI_FLASH_MODEL,
      contents: {
        parts: [
          {
            inlineData: {
              mimeType,
              data: rawBase64
            }
          },
          {
            text: promptText
          }
        ]
      },
      config: {
        systemInstruction,
        ...(/^gemini-[34]/.test(GEMINI_FLASH_MODEL)
          ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
          : {}),
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            foundDate: {
              type: Type.BOOLEAN,
              description: 'True if an expiration / best-before / use-by date is clearly legible.'
            },
            year: {
              type: Type.INTEGER,
              description: '4-digit year (e.g. 2026) or 0 if not found.'
            },
            month: {
              type: Type.INTEGER,
              description: 'Month number 1-12 or 0 if not found.'
            },
            day: {
              type: Type.INTEGER,
              description: 'Day of month 1-31, or 0 if only month & year are printed or not found.'
            },
            isMonthOnly: {
              type: Type.BOOLEAN,
              description: 'True if only month and year are printed without a day.'
            },
            matchedText: {
              type: Type.STRING,
              description: 'Exact date string read from the image.'
            },
            reason: {
              type: Type.STRING,
              description: 'Short status: ok, no_date, only_mfg_found, or illegible.'
            }
          },
          required: ['foundDate', 'year', 'month', 'day', 'isMonthOnly', 'matchedText', 'reason']
        }
      }
    });

    const rawText = (response.text || '').trim();
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (_parseErr) {
      return res.status(502).json({
        error: 'AI returned an unreadable response. Please try again.'
      });
    }

    const durationMs = Date.now() - startTime;

    if (!parsed || !parsed.foundDate) {
      return res.json({
        foundDate: false,
        reason: (parsed && parsed.reason) || 'no_date',
        matchedText: (parsed && parsed.matchedText) || '',
        model: GEMINI_FLASH_MODEL,
        durationMs
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
      return res.json({
        foundDate: false,
        reason: 'invalid_date',
        matchedText: String(parsed.matchedText || ''),
        model: GEMINI_FLASH_MODEL,
        durationMs
      });
    }

    const maxDay = daysInMonth(year, month);
    const day = isMonthOnly ? maxDay : Number(parsed.day);

    if (!Number.isInteger(day) || day < 1 || day > maxDay) {
      return res.json({
        foundDate: false,
        reason: 'invalid_day',
        matchedText: String(parsed.matchedText || ''),
        model: GEMINI_FLASH_MODEL,
        durationMs
      });
    }

    return res.json({
      foundDate: true,
      year,
      month,
      day,
      isMonthOnly,
      matchedText: String(parsed.matchedText || ''),
      reason: 'ok',
      model: GEMINI_FLASH_MODEL,
      durationMs
    });
  } catch (err) {
    console.error('Gemini Flash Scan Error:', err);
    const status = err && (err.status || err.statusCode || (err.error && err.error.code));
    const msg = String((err && err.message) || '');

    if (status === 400 || status === 403 || /API_KEY_INVALID|PERMISSION_DENIED/i.test(msg)) {
      return res.status(status === 403 ? 403 : 400).json({
        error: 'Gemini API key error. Please verify your API key in Settings > Secrets.'
      });
    }
    if (status === 429 || /RESOURCE_EXHAUSTED/i.test(msg)) {
      return res.status(429).json({
        error: 'AI scan rate limit reached. Please wait a moment or use Scan Offline.'
      });
    }
    if (status === 404 || /NOT_FOUND/i.test(msg)) {
      return res.status(502).json({
        error: 'Configured Gemini Flash model was not found. Please contact support.'
      });
    }

    const safeDetail = msg
      .replace(/AIza[0-9A-Za-z\-_]+/g, '[redacted]')
      .slice(0, 240);

    return res.status(502).json({
      error: 'AI scan failed. Please check your connection or try Scan Offline.',
      upstreamStatus: status || null,
      detail: safeDetail || undefined
    });
  }
});

const staticOptions = {
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.wasm')) {
      res.setHeader('Content-Type', 'application/wasm');
      res.setHeader('Cache-Control', 'public, max-age=86400');
    } else if (filePath.endsWith('.mjs')) {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=86400');
    } else if (filePath.endsWith('.onnx')) {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Cache-Control', 'public, max-age=86400');
    } else if (
      filePath.endsWith('.html') ||
      filePath.endsWith('.js') ||
      filePath.endsWith('.css') ||
      filePath.endsWith('.json')
    ) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
};

app.use('/frontend', express.static(path.join(ROOT_DIR, 'frontend'), staticOptions));
app.use('/assets', express.static(path.join(ROOT_DIR, 'assets'), staticOptions));

app.get(['/', '/index.html'], (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(ROOT_DIR, 'index.html'));
});

app.get('/manifest.json', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(ROOT_DIR, 'manifest.json'));
});

app.get('/sw.js', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(path.join(ROOT_DIR, 'sw.js'));
});

app.get('/version.json', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const baseMeta = readStaticVersionMetadata();
  res.json({
    ...baseMeta,
    buildHash: computeAppBuildHash()
  });
});

app.listen(PORT, HOST, () => {
  console.log(`NumPal server listening at http://${HOST}:${PORT}`);
});
