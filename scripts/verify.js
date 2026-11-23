const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function collectJsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'backend') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      // Skip vendored minified ORT runtime files
      if (full.includes(path.join('assets', 'ocr', 'ort'))) continue;
      out.push(full);
    }
  }
  return out;
}

// 1. Validate JS syntax across server, service worker, scripts, backend config, and frontend
const jsFiles = collectJsFiles(ROOT);
const backendConfigPath = path.join(ROOT, 'backend', 'config.js');
if (fs.existsSync(backendConfigPath)) {
  jsFiles.push(backendConfigPath);
}
for (const file of jsFiles) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}
console.log(`Syntax OK (${jsFiles.length} JS files checked)`);

// 2. Validate JSON files
for (const jsonRel of ['package.json', 'manifest.json', 'version.json', 'metadata.json']) {
  const full = path.join(ROOT, jsonRel);
  if (!fs.existsSync(full)) {
    throw new Error(`Missing required JSON file: ${jsonRel}`);
  }
  JSON.parse(fs.readFileSync(full, 'utf8'));
}
console.log('JSON files OK');

// 3. Verify every local asset URL listed in sw.js exists on disk
const swContent = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const assetMatches = [...swContent.matchAll(/['"](\.\/[^'"]+)['"]/g)].map(m => m[1]);
const uniqueAssets = [...new Set(assetMatches)];
const missing = [];
for (const rel of uniqueAssets) {
  if (rel === './') continue;
  const full = path.join(ROOT, rel.slice(2));
  if (!fs.existsSync(full)) {
    missing.push(rel);
  }
}
if (missing.length > 0) {
  throw new Error(`Missing assets referenced in sw.js:\n  - ${missing.join('\n  - ')}`);
}
console.log(`Service Worker precache manifest OK (${uniqueAssets.length} entries verified on disk)`);
