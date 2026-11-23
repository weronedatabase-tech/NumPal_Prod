// ==========================================
// expiry.js - Expiry Date Scanner Logic
// Offline PaddleOCR PP-OCRv4 (Web Worker) + Gemini Flash AI
// ==========================================

const isDevEnv = typeof ENV !== 'undefined' && ENV === 'Dev';
const isProdEnv = typeof ENV !== 'undefined' && ENV === 'Prod';
const prodScanMode =
  typeof PROD_SCAN_MODE !== 'undefined' && String(PROD_SCAN_MODE).trim().toLowerCase() === 'ai'
    ? 'ai'
    : 'offline';
const activeSingleScanMode = isProdEnv ? prodScanMode : 'offline';
const usesOfflineScanner = isDevEnv || activeSingleScanMode === 'offline';

const scanSingleGroup = document.getElementById('scan-single-group');
const scanDevGroup = document.getElementById('scan-dev-group');
const scanExpiryBtn = document.getElementById('scan-expiry-btn');
const scanExpiryAiBtn = document.getElementById('scan-expiry-ai-btn');
const scanOfflineBtn = document.getElementById('scan-offline-btn');
const scanAiBtn = document.getElementById('scan-ai-btn');
const cameraInput = document.getElementById('camera-input');
const manualCheckBtn = document.getElementById('manual-check-btn');
const manualDateDisplay = document.getElementById('manual-date-display');
const processingScreen = document.getElementById('processing-screen');
const processingTitle = document.getElementById('processing-title');
const processingSubtitle = document.getElementById('processing-subtitle');
const goodOverlay = document.getElementById('obnoxious-good');
const badOverlay = document.getElementById('obnoxious-bad');
const notFoundOverlay = document.getElementById('obnoxious-not-found');
const goodDetectedDateEl = document.getElementById('good-detected-date');
const badDetectedDateEl = document.getElementById('bad-detected-date');

// Camera modal elements
const cameraModal = document.getElementById('camera-modal');
const cameraVideo = document.getElementById('camera-video');
const cameraGuideHint = document.getElementById('camera-guide-hint');
const cameraGuideBox = document.getElementById('camera-guide-box');
const cameraCloseBtn = document.getElementById('camera-close-btn');
const cameraCaptureBtn = document.getElementById('camera-capture-btn');
const cameraTorchBtn = document.getElementById('camera-torch-btn');
const cameraFileBtn = document.getElementById('camera-file-btn');

const OCR_CACHE_NAME = 'numpal-ocr-models-v1';
const today = new Date();
const options = { day: 'numeric', month: 'long', year: 'numeric' };
const monthYearOptions = { month: 'long', year: 'numeric' };
document.getElementById('today-date-display').innerText = today.toLocaleDateString('en-GB', options);

let selectedManualDate = null;
let activeScanMode = 'offline'; // 'offline' | 'ai'

// Worker & camera state
let ocrWorker = null;
let ocrReady = false;
let ocrReadyPromise = null;
let nextRequestId = 1;
const pendingRequests = new Map();

let activeStream = null;
let torchOn = false;

// Apply environment-specific scan controls:
// - Dev: 2 side-by-side buttons (Scan Offline & Scan using AI)
// - Prod: single button selected via PROD_SCAN_MODE in config.js ('offline' | 'ai')
// - Exp: single Scan Offline button
(function applyEnvironmentScanUI() {
  if (isDevEnv) {
    if (scanSingleGroup) scanSingleGroup.style.display = 'none';
    if (scanDevGroup) scanDevGroup.style.display = 'grid';
  } else {
    if (scanSingleGroup) scanSingleGroup.style.display = 'block';
    if (scanDevGroup) scanDevGroup.style.display = 'none';
    const showAiSingle = activeSingleScanMode === 'ai';
    if (scanExpiryBtn) scanExpiryBtn.style.display = showAiSingle ? 'none' : 'flex';
    if (scanExpiryAiBtn) scanExpiryAiBtn.style.display = showAiSingle ? 'flex' : 'none';
  }
})();

function getDaysInMonth(month, year) {
  return new Date(year, month, 0).getDate();
}

function formatLocalIsoDate(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function setProcessingUI(visible, title = 'Reading date...', subtitle = '') {
  processingScreen.style.display = visible ? 'flex' : 'none';
  if (processingTitle) processingTitle.textContent = title;
  if (processingSubtitle) processingSubtitle.textContent = subtitle;
}

// ==========================================
// Offline OCR Web Worker Lifecycle
// ==========================================
async function areModelsCached() {
  if (!('caches' in window)) return false;
  try {
    const cache = await caches.open(OCR_CACHE_NAME);
    const keys = await cache.keys();
    const urls = keys.map(r => r.url.split('?')[0]);
    return (
      urls.some(u => u.endsWith('/det.onnx')) &&
      urls.some(u => u.endsWith('/rec.onnx')) &&
      urls.some(u => u.endsWith('/en_dict.txt')) &&
      urls.some(u => u.endsWith('/ort-wasm-simd-threaded.wasm')) &&
      urls.some(u => u.endsWith('/ort-wasm-simd-threaded.mjs'))
    );
  } catch (_err) {
    return false;
  }
}

function ensureWorker() {
  if (ocrWorker) return ocrWorker;

  const workerUrl = new URL('../js/workers/ocr.worker.js', window.location.href);
  ocrWorker = new Worker(workerUrl);

  ocrWorker.onmessage = (event) => {
    const msg = event.data;
    if (!msg) return;

    if (msg.type === 'progress') {
      const pct = msg.percent;
      if (pct < 100 && processingScreen.style.display === 'flex' && activeScanMode === 'offline' && processingSubtitle) {
        processingSubtitle.textContent = `${msg.status || 'Preparing offline scanner...'} (${pct}%)`;
      }
      return;
    }

    if (msg.type === 'ready') {
      ocrReady = true;
      if (ocrReadyPromise && ocrReadyPromise.resolve) {
        ocrReadyPromise.resolve();
      }
      return;
    }

    if (msg.type === 'result') {
      const pending = pendingRequests.get(msg.id);
      if (pending) {
        pendingRequests.delete(msg.id);
        pending.resolve(msg.detections || []);
      }
      return;
    }

    if (msg.type === 'error') {
      if (msg.id && pendingRequests.has(msg.id)) {
        const pending = pendingRequests.get(msg.id);
        pendingRequests.delete(msg.id);
        pending.reject(new Error(msg.message || 'OCR error'));
      } else if (ocrReadyPromise && ocrReadyPromise.reject) {
        ocrReadyPromise.reject(new Error(msg.message || 'Failed to initialize offline scanner'));
        ocrReadyPromise = null;
      }
    }
  };

  ocrWorker.onerror = (err) => {
    const error = new Error(err.message || 'OCR worker failed');
    for (const [, pending] of pendingRequests) {
      pending.reject(error);
    }
    pendingRequests.clear();
    if (ocrReadyPromise && ocrReadyPromise.reject) {
      ocrReadyPromise.reject(error);
      ocrReadyPromise = null;
    }
  };

  return ocrWorker;
}

function initOfflineOcr() {
  if (ocrReady) return Promise.resolve();
  if (ocrReadyPromise) return ocrReadyPromise.promise;

  let resolveFn, rejectFn;
  const promise = new Promise((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  ocrReadyPromise = { promise, resolve: resolveFn, reject: rejectFn };

  const worker = ensureWorker();
  worker.postMessage({ type: 'init' });
  return promise;
}

function runWorkerPass(rgbaUint8Clamped, width, height, mode, isCroppedStrip) {
  return new Promise((resolve, reject) => {
    const worker = ensureWorker();
    const id = nextRequestId++;
    pendingRequests.set(id, { resolve, reject });
    // Copy into transferable buffer so the caller can reuse pixel data for Pass 2 if needed
    const copy = new Uint8ClampedArray(rgbaUint8Clamped);
    worker.postMessage(
      {
        type: 'recognize',
        id,
        buffer: copy.buffer,
        width,
        height,
        mode,
        isCroppedStrip
      },
      [copy.buffer]
    );
  });
}

// Pre-warm offline scanner on page load when offline scanning is enabled
(async function bootstrapOfflineOcr() {
  if (!usesOfflineScanner) return;
  const cached = await areModelsCached();
  if (cached || navigator.onLine) {
    // Warm up sessions in background so the first scan is fast
    initOfflineOcr().catch(() => {});
  }
})();

// Warm up sessions if the Service Worker finishes background OCR caching
window.addEventListener('numpal:ocr-cache-ready', async () => {
  if (usesOfflineScanner && !ocrReady && await areModelsCached()) {
    initOfflineOcr().catch(() => {});
  }
});

// Release ONNX sessions when leaving page to preserve mobile memory
window.addEventListener('pagehide', () => {
  stopCamera();
  if (ocrWorker) {
    try {
      ocrWorker.postMessage({ type: 'release' });
      ocrWorker.terminate();
    } catch (_err) {}
    ocrWorker = null;
    ocrReady = false;
    ocrReadyPromise = null;
  }
});

// ==========================================
// Manual Date Picker (Rolodex)
// ==========================================
window.openDatePicker = function () {
  const currYear = today.getFullYear();

  const startD = selectedManualDate ? selectedManualDate.getDate() : today.getDate();
  const startM = selectedManualDate ? selectedManualDate.getMonth() + 1 : today.getMonth() + 1;
  const startY = selectedManualDate ? selectedManualDate.getFullYear() : currYear;

  window.currentMaxDays = getDaysInMonth(startM, startY);

  window.openRolodex(
    'Select Date',
    [
      { id: 'day', items: window.RoloGen.days(window.currentMaxDays), selectedValue: startD },
      { id: 'month', items: window.RoloGen.monthsSpec(), selectedValue: startM, flex: 1.8 },
      { id: 'year', items: window.RoloGen.years(currYear - 6, 19), selectedValue: startY }
    ],
    (res) => {
      const year = parseInt(res.year, 10);
      const month = parseInt(res.month, 10) - 1;
      const day = parseInt(res.day, 10);

      selectedManualDate = new Date(year, month, day);
      manualDateDisplay.innerText = selectedManualDate.toLocaleDateString('en-GB', options);
    },
    (res, rolo) => {
      const y = parseInt(res.year, 10);
      const m = parseInt(res.month, 10);
      const currentD = parseInt(res.day, 10);

      const maxDays = getDaysInMonth(m, y);

      if (window.currentMaxDays !== maxDays) {
        window.currentMaxDays = maxDays;
        const safeDay = currentD > maxDays ? maxDays : currentD;
        rolo.updateColumn('day', window.RoloGen.days(maxDays), safeDay);
      }
    }
  );
};

function showResultOverlay(isExpired, dateObj, isMonthOnly = false) {
  const formatted = dateObj
    ? isMonthOnly
      ? `End of ${dateObj.toLocaleDateString('en-GB', monthYearOptions)}`
      : dateObj.toLocaleDateString('en-GB', options)
    : '';

  if (isExpired) {
    if (badDetectedDateEl) {
      badDetectedDateEl.textContent = formatted ? `Date read: ${formatted}` : '';
      badDetectedDateEl.style.display = formatted ? 'block' : 'none';
    }
    badOverlay.style.display = 'flex';
  } else {
    if (goodDetectedDateEl) {
      goodDetectedDateEl.textContent = formatted ? `Date read: ${formatted}` : '';
      goodDetectedDateEl.style.display = formatted ? 'block' : 'none';
    }
    goodOverlay.style.display = 'flex';
  }
}

manualCheckBtn.addEventListener('click', () => {
  if (!selectedManualDate) {
    showToast('Please tap to select a date first.', true);
    return;
  }
  setProcessingUI(true, 'Checking date...', '');

  setTimeout(() => {
    setProcessingUI(false);
    const checkDate = new Date(selectedManualDate);
    checkDate.setHours(0, 0, 0, 0);
    const compareToday = new Date(today);
    compareToday.setHours(0, 0, 0, 0);

    showResultOverlay(checkDate < compareToday, checkDate, false);
  }, 400);
});

// ==========================================
// Guided Live Camera Viewfinder + File Fallback
// ==========================================
function updateViewfinderModeUI(mode) {
  const isAi = mode === 'ai';
  if (cameraModal) {
    cameraModal.classList.toggle('ai-mode', isAi);
  }
  if (cameraGuideHint) {
    cameraGuideHint.textContent = isAi
      ? 'AI Scan: Point camera at the expiry date'
      : 'Line up the expiry date inside the box';
  }
  if (cameraCaptureBtn) {
    cameraCaptureBtn.classList.toggle('ai-mode', isAi);
  }
}

function stopCamera() {
  if (activeStream) {
    activeStream.getTracks().forEach(t => t.stop());
    activeStream = null;
  }
  torchOn = false;
  if (cameraTorchBtn) {
    cameraTorchBtn.classList.remove('active');
    cameraTorchBtn.style.display = 'none';
  }
  if (cameraVideo) {
    cameraVideo.srcObject = null;
  }
  if (cameraModal) {
    const wasOpen = cameraModal.classList.contains('open');
    cameraModal.classList.remove('open');
    cameraModal.setAttribute('aria-hidden', 'true');
    if (wasOpen && typeof window.numpalSetBusy === 'function') {
      window.numpalSetBusy(false);
    }
  }
}

async function openCameraViewfinder(mode = 'offline') {
  activeScanMode = mode === 'ai' ? 'ai' : 'offline';
  updateViewfinderModeUI(activeScanMode);

  if (activeScanMode === 'ai') {
    if (!navigator.onLine) {
      showToast(
        usesOfflineScanner
          ? 'AI scan requires an internet connection. Use Scan Offline instead.'
          : 'AI scan requires an internet connection. Please connect or key in the date below.',
        true
      );
      return;
    }
  } else {
    // Check if offline & models not yet downloaded
    const cached = await areModelsCached();
    if (!cached && !navigator.onLine) {
      showToast('Connect once to download the offline scanner (~15 MB), or key in the date below.', true);
      return;
    }
    // Start warming up OCR engine while user aims camera
    initOfflineOcr().catch(() => {});
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    cameraInput.click();
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: false
    });

    activeStream = stream;
    cameraVideo.srcObject = stream;
    cameraModal.classList.add('open');
    cameraModal.setAttribute('aria-hidden', 'false');
    if (typeof window.numpalSetBusy === 'function') {
      window.numpalSetBusy(true);
    }

    // Enable torch toggle if camera track supports flash/torch
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack && typeof videoTrack.getCapabilities === 'function') {
      const caps = videoTrack.getCapabilities();
      if (caps && caps.torch) {
        cameraTorchBtn.style.display = 'inline-block';
      }
    }
  } catch (_err) {
    // Permission denied, no rear camera, or embedded preview restriction -> fallback to file/camera picker
    stopCamera();
    cameraInput.click();
  }
}

function captureFromViewfinder() {
  if (!cameraVideo || !cameraVideo.videoWidth || !cameraVideo.videoHeight) return;

  const vw = cameraVideo.videoWidth;
  const vh = cameraVideo.videoHeight;
  const isAi = activeScanMode === 'ai';

  let sx = 0;
  let sy = 0;
  let sw = vw;
  let sh = vh;
  let outW;
  let outH;

  if (isAi) {
    // AI mode: capture the full camera frame without cropping to the small guide rectangle
    const MAX_SIDE = 1280;
    const maxDim = Math.max(vw, vh);
    const outScale = maxDim > MAX_SIDE ? MAX_SIDE / maxDim : 1;
    outW = Math.max(32, Math.round(vw * outScale));
    outH = Math.max(32, Math.round(vh * outScale));
  } else {
    const vr = cameraVideo.getBoundingClientRect();
    const gr = cameraGuideBox.getBoundingClientRect();

    // Map guide box coordinates onto the underlying video frame accounting for object-fit: cover
    const scale = Math.max(vr.width / vw, vr.height / vh);
    const renderedW = vw * scale;
    const renderedH = vh * scale;
    const offsetX = (vr.width - renderedW) / 2;
    const offsetY = (vr.height - renderedH) / 2;

    const relX = gr.left - vr.left;
    const relY = gr.top - vr.top;

    sx = (relX - offsetX) / scale;
    sy = (relY - offsetY) / scale;
    sw = gr.width / scale;
    sh = gr.height / scale;

    const padX = sw * 0.14;
    const padY = sh * 0.22;
    sx = Math.max(0, sx - padX);
    sy = Math.max(0, sy - padY);
    sw = Math.min(vw - sx, sw + padX * 2);
    sh = Math.min(vh - sy, sh + padY * 2);

    // Scale captured crop cleanly
    const MAX_WIDTH = 960;
    const outScale = sw > MAX_WIDTH ? MAX_WIDTH / sw : 1;
    outW = Math.max(32, Math.round(sw * outScale));
    outH = Math.max(32, Math.round(sh * outScale));
  }

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d', { willReadFrequently: !isAi });
  ctx.drawImage(cameraVideo, sx, sy, sw, sh, 0, 0, outW, outH);

  if (isAi) {
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    const base64 = dataUrl.split(',')[1];
    stopCamera();
    processImageWithAI(base64, 'image/jpeg');
  } else {
    const imageData = ctx.getImageData(0, 0, outW, outH);
    stopCamera();
    processImagePixels(imageData.data, outW, outH, true);
  }
}

// ==========================================
// Scanner 1: Offline PaddleOCR Processing
// ==========================================
async function processImagePixels(rgbaData, width, height, isCroppedStrip) {
  if (typeof window.numpalSetBusy === 'function') window.numpalSetBusy(true);
  setProcessingUI(true, 'Reading date...', ocrReady ? 'Scanning image offline...' : 'Loading offline OCR engine...');

  try {
    await initOfflineOcr();

    // Pass 1: Standard PaddleOCR PP-OCRv4 detection + recognition
    setProcessingUI(true, 'Reading date...', 'Detecting text offline...');
    const pass1Detections = await runWorkerPass(rgbaData, width, height, 'standard', isCroppedStrip);
    let parsed = window.ExpiryDateParser.parse(pass1Detections, today);

    // Pass 2: Dot-matrix rescue enhancement if Pass 1 did not find a valid expiry date
    if (!parsed.foundDate) {
      setProcessingUI(true, 'Reading date...', 'Enhancing dot-matrix print...');
      const pass2Detections = await runWorkerPass(rgbaData, width, height, 'dot-matrix', isCroppedStrip);
      const parsed2 = window.ExpiryDateParser.parse(pass2Detections, today);
      if (parsed2.foundDate) {
        parsed = parsed2;
      }
    }

    setProcessingUI(false);

    if (parsed.foundDate) {
      selectedManualDate = new Date(parsed.date);
      manualDateDisplay.innerText = selectedManualDate.toLocaleDateString('en-GB', options);
      showResultOverlay(parsed.isExpired, parsed.date, parsed.isMonthOnly);
    } else {
      notFoundOverlay.style.display = 'flex';
    }
  } catch (err) {
    console.error('Offline OCR Error:', err);
    setProcessingUI(false);
    if (!navigator.onLine) {
      showToast('Offline scanner needs one online load to cache models.', true);
    } else {
      showToast('Could not read image. Please try again.', true);
    }
  } finally {
    if (typeof window.numpalSetBusy === 'function') window.numpalSetBusy(false);
  }
}

// ==========================================
// Scanner 2: Gemini Flash AI Processing
// ==========================================
function getConfiguredGasApiUrl() {
  if (typeof API_URL !== 'string') return '';
  const trimmed = API_URL.trim();
  return /^https:\/\/.+/i.test(trimmed) ? trimmed : '';
}

function isStaticFrontendHost() {
  const host = (window.location.hostname || '').toLowerCase();
  return host.endsWith('.github.io') || window.location.protocol === 'file:';
}

async function postToGasBackend(gasUrl, payload) {
  // Use text/plain to send a CORS simple request so Google Apps Script does not fail on OPTIONS preflight
  const response = await fetch(gasUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain;charset=utf-8'
    },
    redirect: 'follow',
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (_err) {
    throw new Error(
      'AI backend returned an unexpected response. Verify Google Apps Script Web App deployment and access settings.'
    );
  }

  return { response, data };
}

async function requestAiExpiryScan(payload) {
  const gasUrl = getConfiguredGasApiUrl();

  // GitHub Pages & static hosts cannot serve POST /api/scan-expiry (returns HTTP 405) -> call Apps Script directly
  if (isStaticFrontendHost()) {
    if (!gasUrl) {
      throw new Error('AI scan backend URL is not configured in config.js.');
    }
    return postToGasBackend(gasUrl, payload);
  }

  // Node.js / AI Studio server -> call local /api/scan-expiry first
  const localResponse = await fetch('/api/scan-expiry', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  // Fallback for custom-domain static hosting (e.g. GitHub Pages custom domain) that returns 405/404 for POST /api/*
  if ((localResponse.status === 405 || localResponse.status === 404) && gasUrl) {
    return postToGasBackend(gasUrl, payload);
  }

  const data = await localResponse.json().catch(() => ({}));
  return { response: localResponse, data };
}

async function processImageWithAI(imageBase64, mimeType) {
  if (!navigator.onLine) {
    showToast(
      usesOfflineScanner
        ? 'AI scan requires an internet connection. Use Scan Offline instead.'
        : 'AI scan requires an internet connection. Please connect or key in the date below.',
      true
    );
    return;
  }

  if (typeof window.numpalSetBusy === 'function') window.numpalSetBusy(true);
  setProcessingUI(true, 'Reading date...', 'Scanning with Gemini Flash AI...');

  try {
    const payload = {
      imageBase64,
      mimeType: mimeType || 'image/jpeg',
      todayIso: formatLocalIsoDate(today)
    };

    const { response, data } = await requestAiExpiryScan(payload);

    if (!response.ok || (data && data.error)) {
      const errMsg =
        data && typeof data.error === 'string'
          ? data.error
          : data && typeof data.message === 'string'
            ? data.message
            : `AI scan failed (${response.status})`;
      throw new Error(errMsg);
    }

    if (data && data.rawText === 'Sample OCR Data' && !data.year) {
      throw new Error('Apps Script backend is outdated. Deploy backend/Code.js to Google Apps Script.');
    }

    setProcessingUI(false);

    if (data && data.foundDate && data.year && data.month && data.day) {
      const detectedDate = new Date(data.year, data.month - 1, data.day);
      detectedDate.setHours(0, 0, 0, 0);

      const compareToday = new Date(today);
      compareToday.setHours(0, 0, 0, 0);

      selectedManualDate = new Date(detectedDate);
      manualDateDisplay.innerText = selectedManualDate.toLocaleDateString('en-GB', options);
      showResultOverlay(detectedDate < compareToday, detectedDate, Boolean(data.isMonthOnly));
    } else {
      notFoundOverlay.style.display = 'flex';
    }
  } catch (err) {
    console.error('Gemini Flash AI Scan Error:', err);
    setProcessingUI(false);
    showToast(
      err.message ||
        (usesOfflineScanner
          ? 'AI scan failed. Please try again or use Scan Offline.'
          : 'AI scan failed. Please try again or key in the date below.'),
      true
    );
  } finally {
    if (typeof window.numpalSetBusy === 'function') window.numpalSetBusy(false);
  }
}

// ==========================================
// Image File Loaders
// ==========================================
function loadFileToRGBA(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const MAX_SIDE = 1024;
        let scale = 1;
        if (Math.max(img.width, img.height) > MAX_SIDE) {
          scale = MAX_SIDE / Math.max(img.width, img.height);
        }
        const w = Math.max(32, Math.round(img.width * scale));
        const h = Math.max(32, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, w, h);
        const imageData = ctx.getImageData(0, 0, w, h);
        resolve({ data: imageData.data, width: w, height: h });
      };
      img.onerror = () => reject(new Error('Invalid image file'));
      img.src = event.target.result;
    };
    reader.onerror = () => reject(new Error('Failed to read image file'));
    reader.readAsDataURL(file);
  });
}

function loadFileToJpegBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const MAX_SIDE = 1280;
        let scale = 1;
        if (Math.max(img.width, img.height) > MAX_SIDE) {
          scale = MAX_SIDE / Math.max(img.width, img.height);
        }
        const w = Math.max(32, Math.round(img.width * scale));
        const h = Math.max(32, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        resolve({ base64: dataUrl.split(',')[1], mimeType: 'image/jpeg' });
      };
      img.onerror = () => reject(new Error('Invalid image file'));
      img.src = event.target.result;
    };
    reader.onerror = () => reject(new Error('Failed to read image file'));
    reader.readAsDataURL(file);
  });
}

// ==========================================
// Event Bindings
// ==========================================
if (scanExpiryBtn) {
  scanExpiryBtn.addEventListener('click', () => openCameraViewfinder('offline'));
}
if (scanExpiryAiBtn) {
  scanExpiryAiBtn.addEventListener('click', () => openCameraViewfinder('ai'));
}
if (scanOfflineBtn) {
  scanOfflineBtn.addEventListener('click', () => openCameraViewfinder('offline'));
}
if (scanAiBtn) {
  scanAiBtn.addEventListener('click', () => openCameraViewfinder('ai'));
}

cameraCloseBtn.addEventListener('click', stopCamera);
cameraCaptureBtn.addEventListener('click', captureFromViewfinder);
cameraFileBtn.addEventListener('click', () => {
  stopCamera();
  cameraInput.click();
});

cameraTorchBtn.addEventListener('click', async () => {
  if (!activeStream) return;
  const track = activeStream.getVideoTracks()[0];
  if (!track) return;
  try {
    torchOn = !torchOn;
    await track.applyConstraints({ advanced: [{ torch: torchOn }] });
    cameraTorchBtn.classList.toggle('active', torchOn);
  } catch (_err) {
    torchOn = false;
    cameraTorchBtn.classList.remove('active');
  }
});

cameraInput.addEventListener('change', async (e) => {
  if (!e.target.files || e.target.files.length === 0) return;
  const file = e.target.files[0];
  try {
    if (activeScanMode === 'ai') {
      const { base64, mimeType } = await loadFileToJpegBase64(file);
      await processImageWithAI(base64, mimeType);
    } else {
      const { data, width, height } = await loadFileToRGBA(file);
      await processImagePixels(data, width, height, false);
    }
  } catch (_err) {
    showToast('Could not open image. Please try again.', true);
  } finally {
    cameraInput.value = '';
  }
});