// ==========================================
// ocr.worker.js - Offline PaddleOCR (PP-OCRv4 Mobile) Web Worker
// Runs 100% locally via onnxruntime-web (single-threaded WASM, no COOP/COEP needed)
// ==========================================

const OCR_CACHE_NAME = 'numpal-ocr-models-v1';

// Resolve local asset URLs relative to this worker (/frontend/js/workers/ocr.worker.js)
const ORT_BASE_URL = new URL('../../../assets/ocr/ort/', self.location.href).href;
const MODELS_BASE_URL = new URL('../../../assets/ocr/models/', self.location.href).href;

const ASSET_URLS = {
  det: MODELS_BASE_URL + 'det.onnx',
  rec: MODELS_BASE_URL + 'rec.onnx',
  dict: MODELS_BASE_URL + 'en_dict.txt',
  wasm: ORT_BASE_URL + 'ort-wasm-simd-threaded.wasm',
  wasmMjs: ORT_BASE_URL + 'ort-wasm-simd-threaded.mjs'
};

// Load local onnxruntime-web WASM build
importScripts(ORT_BASE_URL + 'ort.wasm.min.js');

let detSession = null;
let recSession = null;
let vocab = null;
let initPromise = null;

function postProgress(percent, status) {
  self.postMessage({ type: 'progress', percent, status });
}

// Fetch an asset with Cache Storage persistence and streaming progress reporting
async function fetchWithCache(url, onChunk) {
  let cache = null;
  if ('caches' in self) {
    try {
      cache = await caches.open(OCR_CACHE_NAME);
      const cached = await cache.match(url, { ignoreSearch: true });
      if (cached && cached.ok) {
        const buf = await cached.arrayBuffer();
        if (onChunk) onChunk(buf.byteLength, buf.byteLength);
        return buf;
      }
    } catch (_err) {
      // Fall back to direct network fetch if Cache Storage is unavailable
    }
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url} (${response.status})`);
  }

  const contentLength = Number(response.headers.get('content-length')) || 0;
  let buffer;

  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      if (onChunk) onChunk(received, contentLength || received);
    }

    const combined = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    buffer = combined.buffer;
  } else {
    buffer = await response.arrayBuffer();
    if (onChunk) onChunk(buffer.byteLength, buffer.byteLength);
  }

  if (cache) {
    try {
      const headers = new Headers();
      const ct = response.headers.get('content-type');
      if (ct) headers.set('content-type', ct);
      headers.set('content-length', String(buffer.byteLength));
      await cache.put(url, new Response(buffer.slice(0), { status: 200, headers }));
    } catch (_err) {
      // Ignore quota errors; inference can still proceed with in-memory buffer
    }
  }

  return buffer;
}

async function initEngine() {
  if (detSession && recSession && vocab) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      // Configure ONNX Runtime Web for maximum compatibility (GitHub Pages + iOS Safari)
      ort.env.wasm.wasmPaths = ORT_BASE_URL;
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.simd = true;
      ort.env.wasm.proxy = false;

      // Track combined download progress across WASM (~15MB) + det (~4.6MB) + rec (~7.4MB)
      const weights = { wasm: 0.50, det: 0.18, rec: 0.28, dict: 0.04 };
      const progressState = { wasm: 0, det: 0, rec: 0, dict: 0 };

      const reportCombined = (status) => {
        const total =
          progressState.wasm * weights.wasm +
          progressState.det * weights.det +
          progressState.rec * weights.rec +
          progressState.dict * weights.dict;
        postProgress(Math.min(92, Math.round(total * 92)), status);
      };

      postProgress(2, 'Loading offline OCR engine...');

      // Pre-cache WASM runtime assets so future offline loads work seamlessly
      await fetchWithCache(ASSET_URLS.wasmMjs);
      await fetchWithCache(ASSET_URLS.wasm, (loaded, total) => {
        progressState.wasm = total > 0 ? Math.min(1, loaded / total) : 0.5;
        reportCombined('Caching OCR runtime...');
      });
      progressState.wasm = 1;

      const detBuf = await fetchWithCache(ASSET_URLS.det, (loaded, total) => {
        progressState.det = total > 0 ? Math.min(1, loaded / total) : 0.5;
        reportCombined('Loading text detector...');
      });
      progressState.det = 1;

      const recBuf = await fetchWithCache(ASSET_URLS.rec, (loaded, total) => {
        progressState.rec = total > 0 ? Math.min(1, loaded / total) : 0.5;
        reportCombined('Loading text recognizer...');
      });
      progressState.rec = 1;

      const dictBuf = await fetchWithCache(ASSET_URLS.dict);
      progressState.dict = 1;

      const dictText = new TextDecoder('utf-8').decode(dictBuf);
      const dictLines = dictText.split(/\r?\n/).filter(l => l.length > 0);
      // PaddleOCR CTCLabelDecode: index 0 = blank, 1..N = dict chars, N+1 = space
      vocab = ['', ...dictLines, ' '];

      postProgress(95, 'Starting offline engine...');

      detSession = await ort.InferenceSession.create(new Uint8Array(detBuf), {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all'
      });

      recSession = await ort.InferenceSession.create(new Uint8Array(recBuf), {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all'
      });

      postProgress(100, 'Offline scanner ready');
    } catch (err) {
      initPromise = null;
      throw err;
    }
  })();

  return initPromise;
}

// ==========================================
// Pure-JS Image Processing Utilities (No OpenCV.js needed)
// ==========================================

// Bilinear resize of RGBA buffer
function resizeRGBA(src, srcW, srcH, dstW, dstH) {
  const dst = new Uint8ClampedArray(dstW * dstH * 4);
  const scaleX = srcW / dstW;
  const scaleY = srcH / dstH;

  for (let y = 0; y < dstH; y++) {
    const sy = (y + 0.5) * scaleY - 0.5;
    const y0 = Math.max(0, Math.min(srcH - 1, Math.floor(sy)));
    const y1 = Math.max(0, Math.min(srcH - 1, y0 + 1));
    const wy = Math.max(0, sy - y0);

    for (let x = 0; x < dstW; x++) {
      const sx = (x + 0.5) * scaleX - 0.5;
      const x0 = Math.max(0, Math.min(srcW - 1, Math.floor(sx)));
      const x1 = Math.max(0, Math.min(srcW - 1, x0 + 1));
      const wx = Math.max(0, sx - x0);

      const i00 = (y0 * srcW + x0) * 4;
      const i10 = (y0 * srcW + x1) * 4;
      const i01 = (y1 * srcW + x0) * 4;
      const i11 = (y1 * srcW + x1) * 4;
      const out = (y * dstW + x) * 4;

      const w00 = (1 - wx) * (1 - wy);
      const w10 = wx * (1 - wy);
      const w01 = (1 - wx) * wy;
      const w11 = wx * wy;

      dst[out] = src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11;
      dst[out + 1] = src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11;
      dst[out + 2] = src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11;
      dst[out + 3] = 255;
    }
  }
  return dst;
}

// Crop rectangular region from RGBA buffer
function cropRGBA(src, srcW, srcH, rx, ry, rw, rh) {
  const x0 = Math.max(0, Math.min(srcW - 1, Math.floor(rx)));
  const y0 = Math.max(0, Math.min(srcH - 1, Math.floor(ry)));
  const x1 = Math.max(x0 + 1, Math.min(srcW, Math.ceil(rx + rw)));
  const y1 = Math.max(y0 + 1, Math.min(srcH, Math.ceil(ry + rh)));
  const w = x1 - x0;
  const h = y1 - y0;
  const dst = new Uint8ClampedArray(w * h * 4);

  for (let y = 0; y < h; y++) {
    const srcStart = ((y0 + y) * srcW + x0) * 4;
    dst.set(src.subarray(srcStart, srcStart + w * 4), y * w * 4);
  }
  return { data: dst, width: w, height: h };
}

// Rotate RGBA 90 degrees counter-clockwise (for vertically oriented text boxes)
function rotate90CCW(src, w, h) {
  const dst = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      const nx = y;
      const ny = w - 1 - x;
      const di = (ny * h + nx) * 4;
      dst[di] = src[si];
      dst[di + 1] = src[si + 1];
      dst[di + 2] = src[si + 2];
      dst[di + 3] = 255;
    }
  }
  return { data: dst, width: h, height: w };
}

// Dot-matrix rescue preprocessing:
// Grayscale -> percentile contrast stretch -> gentle 3x3 dark/light stroke bridging
function enhanceForDotMatrix(rgba, width, height) {
  const n = width * height;
  const gray = new Uint8Array(n);
  const hist = new Uint32Array(256);

  for (let i = 0; i < n; i++) {
    const idx = i * 4;
    const g = Math.round(0.299 * rgba[idx] + 0.587 * rgba[idx + 1] + 0.114 * rgba[idx + 2]);
    gray[i] = g;
    hist[g]++;
  }

  // Find 0.2% and 99.8% percentiles (safe even when small expiry text covers <2% of the frame)
  const lowTarget = Math.max(1, Math.floor(n * 0.002));
  const highTarget = Math.min(n - 1, Math.floor(n * 0.998));
  let acc = 0, pLow = 0, pHigh = 255;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= lowTarget) { pLow = v; break; }
  }
  acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= highTarget) { pHigh = v; break; }
  }
  // Fallback to true min/max if percentiles collapsed on a mostly uniform background
  if (pHigh - pLow < 20) {
    pLow = 0;
    while (pLow < 255 && hist[pLow] === 0) pLow++;
    pHigh = 255;
    while (pHigh > 0 && hist[pHigh] === 0) pHigh--;
  }
  const span = Math.max(1, pHigh - pLow);

  const stretched = new Uint8Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) {
    const v = pHigh > pLow
      ? Math.max(0, Math.min(255, Math.round(((gray[i] - pLow) * 255) / span)))
      : gray[i];
    stretched[i] = v;
    mean += v;
  }
  mean /= n;

  // If background is bright (mean >= 115), dark ink benefits from 3x3 8-neighbor min-filter (dark dilation)
  // If background is dark (mean < 115), white/light inkjet benefits from 3x3 8-neighbor max-filter + inversion
  const darkBackground = mean < 115;
  const dilated = new Uint8Array(n);

  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - 1);
    const y1 = Math.min(height - 1, y + 1);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(width - 1, x + 1);

      let ext = darkBackground ? 0 : 255;
      for (let yy = y0; yy <= y1; yy++) {
        const row = yy * width;
        for (let xx = x0; xx <= x1; xx++) {
          const v = stretched[row + xx];
          if (darkBackground) {
            if (v > ext) ext = v;
          } else {
            if (v < ext) ext = v;
          }
        }
      }
      dilated[y * width + x] = darkBackground ? 255 - ext : ext;
    }
  }

  // Light 3x3 Gaussian smoothing to soften jagged dilated dot edges before OCR
  const out = new Uint8ClampedArray(n * 4);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - 1);
    const y1 = Math.min(height - 1, y + 1);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(width - 1, x + 1);
      const sum =
        dilated[y0 * width + x0] + 2 * dilated[y0 * width + x] + dilated[y0 * width + x1] +
        2 * dilated[y * width + x0] + 4 * dilated[y * width + x] + 2 * dilated[y * width + x1] +
        dilated[y1 * width + x0] + 2 * dilated[y1 * width + x] + dilated[y1 * width + x1];
      const v = Math.round(sum / 16);
      const idx = (y * width + x) * 4;
      out[idx] = v;
      out[idx + 1] = v;
      out[idx + 2] = v;
      out[idx + 3] = 255;
    }
  }
  return out;
}

// ==========================================
// Stage 1: DBNet Text Detection (PP-OCRv4 Det)
// ==========================================

async function detectTextBoxes(rgba, srcW, srcH, maxSide = 768, isDotMatrix = false) {
  let scale = 1.0;
  if (Math.max(srcW, srcH) > maxSide) {
    scale = maxSide / Math.max(srcW, srcH);
  }
  let dstW = Math.max(32, Math.round((srcW * scale) / 32) * 32);
  let dstH = Math.max(32, Math.round((srcH * scale) / 32) * 32);

  const resized = (dstW === srcW && dstH === srcH)
    ? rgba
    : resizeRGBA(rgba, srcW, srcH, dstW, dstH);

  // PaddleOCR DBNet normalization: ImageNet mean/std in CHW layout
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  const plane = dstW * dstH;
  const inputData = new Float32Array(3 * plane);

  for (let i = 0; i < plane; i++) {
    const idx = i * 4;
    inputData[i] = (resized[idx] / 255 - mean[0]) / std[0];
    inputData[plane + i] = (resized[idx + 1] / 255 - mean[1]) / std[1];
    inputData[2 * plane + i] = (resized[idx + 2] / 255 - mean[2]) / std[2];
  }

  const tensor = new ort.Tensor('float32', inputData, [1, 3, dstH, dstW]);
  const outputMap = await detSession.run({ [detSession.inputNames[0]]: tensor });
  const probTensor = outputMap[detSession.outputNames[0]];
  const prob = probTensor.data; // [1, 1, dstH, dstW]

  // Connected-component extraction on thresholded DBNet probability map
  const thresh = isDotMatrix ? 0.22 : 0.28;
  const boxThresh = isDotMatrix ? 0.36 : 0.48;
  const unclipRatio = 1.65;
  const visited = new Uint8Array(plane);
  const queue = new Int32Array(plane);
  const boxes = [];

  const ratioX = srcW / dstW;
  const ratioY = srcH / dstH;

  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const startIdx = y * dstW + x;
      if (visited[startIdx] || prob[startIdx] < thresh) continue;

      let head = 0, tail = 0;
      queue[tail++] = startIdx;
      visited[startIdx] = 1;

      let minX = x, maxX = x, minY = y, maxY = y;
      let scoreSum = 0;
      let count = 0;

      while (head < tail) {
        const cur = queue[head++];
        const cx = cur % dstW;
        const cy = (cur - cx) / dstW;
        scoreSum += prob[cur];
        count++;

        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        if (cx > 0 && !visited[cur - 1] && prob[cur - 1] >= thresh) {
          visited[cur - 1] = 1;
          queue[tail++] = cur - 1;
        }
        if (cx + 1 < dstW && !visited[cur + 1] && prob[cur + 1] >= thresh) {
          visited[cur + 1] = 1;
          queue[tail++] = cur + 1;
        }
        if (cy > 0 && !visited[cur - dstW] && prob[cur - dstW] >= thresh) {
          visited[cur - dstW] = 1;
          queue[tail++] = cur - dstW;
        }
        if (cy + 1 < dstH && !visited[cur + dstW] && prob[cur + dstW] >= thresh) {
          visited[cur + dstW] = 1;
          queue[tail++] = cur + dstW;
        }
      }

      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      if (bw < 3 || bh < 3 || count < 6) continue;

      const avgScore = scoreSum / count;
      if (avgScore < boxThresh) continue;

      // DBNet unclip expansion (shrunk during training, expand back for full glyph capture)
      const area = bw * bh;
      const perimeter = 2 * (bw + bh);
      const expand = (area * unclipRatio) / Math.max(1, perimeter);
      const padX = Math.max(2, expand * 1.15);
      const padY = Math.max(2, expand * 0.9);

      const ex0 = Math.max(0, (minX - padX) * ratioX);
      const ey0 = Math.max(0, (minY - padY) * ratioY);
      const ex1 = Math.min(srcW, (maxX + 1 + padX) * ratioX);
      const ey1 = Math.min(srcH, (maxY + 1 + padY) * ratioY);

      boxes.push({
        x: ex0,
        y: ey0,
        width: Math.max(1, ex1 - ex0),
        height: Math.max(1, ey1 - ey0),
        detScore: avgScore
      });
    }
  }

  // Sort reading order: top to bottom, left to right
  boxes.sort((a, b) => a.y - b.y || a.x - b.x);
  return boxes;
}

// ==========================================
// Stage 2: SVTR/CRNN Text Recognition (en_PP-OCRv4 Rec)
// ==========================================

async function recognizeCrop(cropData, cropW, cropH) {
  let data = cropData;
  let w = cropW;
  let h = cropH;

  // Handle vertically rotated text strips
  if (h > w * 1.6) {
    const rot = rotate90CCW(data, w, h);
    data = rot.data;
    w = rot.width;
    h = rot.height;
  }

  const targetH = 48;
  const ratio = w / Math.max(1, h);
  const targetW = Math.max(32, Math.min(640, Math.round(targetH * ratio)));

  const resized = resizeRGBA(data, w, h, targetW, targetH);
  const plane = targetW * targetH;
  const inputData = new Float32Array(3 * plane);

  for (let i = 0; i < plane; i++) {
    const idx = i * 4;
    inputData[i] = (resized[idx] / 255 - 0.5) / 0.5;
    inputData[plane + i] = (resized[idx + 1] / 255 - 0.5) / 0.5;
    inputData[2 * plane + i] = (resized[idx + 2] / 255 - 0.5) / 0.5;
  }

  const tensor = new ort.Tensor('float32', inputData, [1, 3, targetH, targetW]);
  const outputMap = await recSession.run({ [recSession.inputNames[0]]: tensor });
  const probs = outputMap[recSession.outputNames[0]];
  const [, timeSteps, numClasses] = probs.dims;
  const arr = probs.data;

  let text = '';
  let confSum = 0;
  let charCount = 0;
  let prevIdx = -1;

  for (let t = 0; t < timeSteps; t++) {
    const rowOffset = t * numClasses;
    let bestIdx = 0;
    let bestVal = arr[rowOffset];
    for (let c = 1; c < numClasses; c++) {
      const v = arr[rowOffset + c];
      if (v > bestVal) {
        bestVal = v;
        bestIdx = c;
      }
    }
    if (bestIdx !== 0 && bestIdx !== prevIdx) {
      const ch = vocab[bestIdx];
      if (ch !== undefined) {
        text += ch;
        confSum += bestVal;
        charCount++;
      }
    }
    prevIdx = bestIdx;
  }

  return {
    text: text.trim(),
    confidence: charCount > 0 ? confSum / charCount : 0
  };
}

async function runOcrPipeline(rgba, width, height, mode = 'standard', isCroppedStrip = false) {
  await initEngine();

  const workingRgba = mode === 'dot-matrix'
    ? enhanceForDotMatrix(rgba, width, height)
    : rgba;

  const maxSide = isCroppedStrip ? 640 : 832;
  const boxes = await detectTextBoxes(workingRgba, width, height, maxSide, mode === 'dot-matrix');
  const detections = [];

  // Limit max boxes to avoid pathological stalls on super noisy full-frame images
  const limitedBoxes = boxes.slice(0, 40);

  for (const box of limitedBoxes) {
    const cropped = cropRGBA(workingRgba, width, height, box.x, box.y, box.width, box.height);
    const rec = await recognizeCrop(cropped.data, cropped.width, cropped.height);
    if (rec.text && rec.confidence >= 0.35) {
      detections.push({
        text: rec.text,
        confidence: rec.confidence,
        box: { x: box.x, y: box.y, width: box.width, height: box.height }
      });
    }
  }

  // Fallback for tight cropped strips if DBNet missed faint inkjet text:
  // recognize the whole strip directly as a single line
  if (detections.length === 0 && isCroppedStrip && width > height) {
    const directRec = await recognizeCrop(workingRgba, width, height);
    if (directRec.text && directRec.confidence >= 0.35) {
      detections.push({
        text: directRec.text,
        confidence: directRec.confidence,
        box: { x: 0, y: 0, width, height }
      });
    }
  }

  return detections;
}

// ==========================================
// Worker Message Handler
// ==========================================
self.onmessage = async (event) => {
  const msg = event.data;
  if (!msg || !msg.type) return;

  if (msg.type === 'init') {
    try {
      await initEngine();
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'error', id: msg.id, message: err.message || String(err) });
    }
    return;
  }

  if (msg.type === 'recognize') {
    const { id, buffer, width, height, mode, isCroppedStrip } = msg;
    try {
      const rgba = new Uint8ClampedArray(buffer);
      const detections = await runOcrPipeline(rgba, width, height, mode || 'standard', !!isCroppedStrip);
      self.postMessage({ type: 'result', id, detections });
    } catch (err) {
      self.postMessage({ type: 'error', id, message: err.message || String(err) });
    }
    return;
  }

  if (msg.type === 'release') {
    try {
      if (detSession) { await detSession.release(); detSession = null; }
      if (recSession) { await recSession.release(); recSession = null; }
      initPromise = null;
    } catch (_err) {
      // Ignore cleanup errors
    }
  }
};
