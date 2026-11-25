const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const ROOT_DIR = __dirname;

const TRACKED_APP_FILES = [
  'index.html',
  'manifest.json',
  'sw.js',
  'version.json',
  'frontend/css/styles.css',
  'backend/config.js',
  'frontend/js/core/app.js',
  'frontend/js/utils/ui.js',
  'frontend/js/utils/admin-models.js',
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
    return { name: 'NumPal', version: '1.1.0', cacheVersion: 'v116' };
  }
}

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

app.get('/backend/config.js', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(ROOT_DIR, 'backend', 'config.js'));
});

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
