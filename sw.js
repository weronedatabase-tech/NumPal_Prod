const CACHE_NAME = 'numpal-cache-v112';
const OCR_MODEL_CACHE = 'numpal-ocr-models-v1';

// Tier 1A: Lightweight HTML, CSS, JS, and metadata files.
// Served Network-First (with fast cache fallback) and checked for updates automatically.
const CORE_CODE_URLS = [
  './index.html',
  './manifest.json',
  './version.json',
  './frontend/css/styles.css',
  './frontend/js/core/config.js',
  './frontend/js/core/app.js',
  './frontend/js/utils/ui.js',
  './frontend/js/utils/rolodex.js',
  './frontend/js/utils/date-parser.js',
  './frontend/js/workers/ocr.worker.js',
  './frontend/js/pages/duration.js',
  './frontend/js/pages/end-time.js',
  './frontend/js/pages/expiry.js',
  './frontend/js/pages/purchasing2.js',
  './frontend/js/pages/stopwatch.js',
  './frontend/pages/duration.html',
  './frontend/pages/end-time.html',
  './frontend/pages/expiry.html',
  './frontend/pages/purchasing2.html',
  './frontend/pages/stopwatch.html',
  './frontend/pages/time-menu.html'
];

// Tier 1B: Static images and lightweight ORT JS loader precached on install.
const CORE_IMAGE_URLS = [
  './assets/ocr/ort/ort.wasm.min.js',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/note-100.png',
  './assets/note-50.png',
  './assets/note-10.png',
  './assets/note-5.png',
  './assets/note-2.png',
  './assets/coin-1.png',
  './assets/coin-50c.png',
  './assets/coin-20c.png',
  './assets/coin-10c.png',
  './assets/coin-5c.png',
  './assets/Organisation_Logo.png'
];

// Tier 2: Offline PaddleOCR ONNX models & WASM binaries (~27 MB).
// Stored in a dedicated cache preserved across app shell updates and warmed silently
// in the background right after activation so the entire app works 100% offline.
const OCR_MODEL_URLS = [
  './assets/ocr/ort/ort.wasm.min.mjs',
  './assets/ocr/ort/ort-wasm-simd-threaded.mjs',
  './assets/ocr/ort/ort-wasm-simd-threaded.wasm',
  './assets/ocr/models/det.onnx',
  './assets/ocr/models/rec.onnx',
  './assets/ocr/models/en_dict.txt'
];

const PRECACHE_URLS = ['./', ...CORE_CODE_URLS, ...CORE_IMAGE_URLS];

let ocrWarmPromise = null;
let updateCheckPromise = null;
let lastUpdateCheckAt = 0;

function resolveScopeUrl(relPath) {
  return new URL(relPath, self.registration.scope).href;
}

function getCleanCacheUrl(urlStr) {
  const u = new URL(urlStr);
  u.search = '';
  u.hash = '';
  const scopeUrl = new URL(self.registration.scope);
  if (u.pathname === scopeUrl.pathname || u.pathname + '/' === scopeUrl.pathname) {
    return resolveScopeUrl('./index.html');
  }
  return u.href;
}

function normalizeEtag(etag) {
  if (!etag) return '';
  return etag.trim().replace(/^W\//i, '');
}

async function broadcastToClients(message) {
  const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: false });
  for (const client of clientList) {
    client.postMessage(message);
  }
}

// Silently cache all Tier 2 OCR assets in the background (skips already-cached files)
function warmOcrCache() {
  if (ocrWarmPromise) return ocrWarmPromise;

  ocrWarmPromise = (async () => {
    try {
      const cache = await caches.open(OCR_MODEL_CACHE);
      let allCached = true;

      for (const relPath of OCR_MODEL_URLS) {
        const absUrl = resolveScopeUrl(relPath);
        const existing = await cache.match(absUrl, { ignoreSearch: true });
        if (existing && existing.ok) continue;

        try {
          const response = await fetch(absUrl, { cache: 'no-cache' });
          if (response && response.ok) {
            await cache.put(absUrl, response.clone());
          } else {
            allCached = false;
          }
        } catch (_err) {
          allCached = false;
        }
      }

      if (allCached) {
        await broadcastToClients({ type: 'OCR_CACHE_READY' });
      }
    } catch (_err) {
      // Ignore background warming errors (e.g., offline or quota)
    } finally {
      ocrWarmPromise = null;
    }
  })();

  return ocrWarmPromise;
}

// Auto-detect changes in version.json OR any core HTML/CSS/JS file (even if sw.js was untouched)
async function checkForAppUpdates(force = false) {
  const now = Date.now();
  if (!force && now - lastUpdateCheckAt < 15000) {
    return { updated: false, skipped: true };
  }
  if (updateCheckPromise) return updateCheckPromise;

  updateCheckPromise = (async () => {
    lastUpdateCheckAt = Date.now();
    try {
      const cache = await caches.open(CACHE_NAME);
      const versionUrl = resolveScopeUrl('./version.json');

      // 1. Check version.json first (network no-store)
      let versionChanged = false;
      let freshVersionText = null;
      let freshVersionHeaders = null;
      try {
        const vRes = await fetch(versionUrl, { cache: 'no-store' });
        if (vRes && vRes.ok) {
          freshVersionText = await vRes.text();
          freshVersionHeaders = vRes.headers;
          const cachedV = await cache.match(versionUrl, { ignoreSearch: true });
          const cachedVText = cachedV ? await cachedV.text() : null;
          if (cachedVText !== null && cachedVText !== freshVersionText) {
            versionChanged = true;
          } else if (cachedVText === null) {
            // Seed version.json into cache without triggering spurious reload
            const seedHeaders = new Headers();
            seedHeaders.set('content-type', 'application/json; charset=utf-8');
            await cache.put(versionUrl, new Response(freshVersionText, { status: 200, headers: seedHeaders }));
          }
        }
      } catch (_err) {
        // Offline or unreachable — abort update check cleanly
        return { updated: false, offline: true };
      }

      // 2. Check all core code files via lightweight HEAD requests (or all if versionChanged)
      const codeFiles = CORE_CODE_URLS.filter(p => p !== './version.json');
      const candidatesToFetch = [];

      if (versionChanged) {
        candidatesToFetch.push(...codeFiles);
      } else {
        const BATCH_SIZE = 5;
        for (let i = 0; i < codeFiles.length; i += BATCH_SIZE) {
          const batch = codeFiles.slice(i, i + BATCH_SIZE);
          await Promise.all(
            batch.map(async relPath => {
              const absUrl = resolveScopeUrl(relPath);
              const cached = await cache.match(absUrl, { ignoreSearch: true });
              if (!cached) {
                candidatesToFetch.push(relPath);
                return;
              }
              try {
                const headRes = await fetch(absUrl, { method: 'HEAD', cache: 'no-cache' });
                if (!headRes || !headRes.ok) return;

                const cachedEtag = normalizeEtag(cached.headers.get('etag'));
                const liveEtag = normalizeEtag(headRes.headers.get('etag'));
                const cachedMod = cached.headers.get('last-modified') || '';
                const liveMod = headRes.headers.get('last-modified') || '';

                if (cachedEtag && liveEtag) {
                  if (cachedEtag !== liveEtag) candidatesToFetch.push(relPath);
                } else if (cachedMod && liveMod) {
                  if (cachedMod !== liveMod) candidatesToFetch.push(relPath);
                } else {
                  // Proxy stripped ETag & Last-Modified; verify body directly
                  candidatesToFetch.push(relPath);
                }
              } catch (_err) {
                // Network dropped mid-check; skip
              }
            })
          );
        }
      }

      if (!versionChanged && candidatesToFetch.length === 0) {
        return { updated: false };
      }

      // 3. Fetch candidate files with cache:'reload' and verify actual content diff
      const stagedUpdates = [];
      let anyActualContentChanged = versionChanged;

      for (const relPath of candidatesToFetch) {
        const absUrl = resolveScopeUrl(relPath);
        try {
          const freshRes = await fetch(absUrl, { cache: 'reload' });
          if (!freshRes || !freshRes.ok) {
            // Abort atomic update if a required file failed to download
            return { updated: false, error: true };
          }
          const newText = await freshRes.clone().text();
          const cached = await cache.match(absUrl, { ignoreSearch: true });
          const oldText = cached ? await cached.text() : null;

          if (oldText === null || newText !== oldText) {
            anyActualContentChanged = true;
          }
          stagedUpdates.push({ relPath, absUrl, response: freshRes });
        } catch (_err) {
          return { updated: false, offline: true };
        }
      }

      // 4. If version changed, also refresh any static image whose metadata changed
      if (versionChanged) {
        await Promise.all(
          CORE_IMAGE_URLS.map(async relPath => {
            const absUrl = resolveScopeUrl(relPath);
            try {
              const cached = await cache.match(absUrl, { ignoreSearch: true });
              const headRes = await fetch(absUrl, { method: 'HEAD', cache: 'no-cache' });
              if (!headRes || !headRes.ok) return;

              const cachedEtag = cached ? normalizeEtag(cached.headers.get('etag')) : '';
              const liveEtag = normalizeEtag(headRes.headers.get('etag'));
              const cachedMod = cached ? (cached.headers.get('last-modified') || '') : '';
              const liveMod = headRes.headers.get('last-modified') || '';

              const changed =
                !cached ||
                (cachedEtag && liveEtag && cachedEtag !== liveEtag) ||
                (!cachedEtag && cachedMod && liveMod && cachedMod !== liveMod);

              if (changed) {
                const imgRes = await fetch(absUrl, { cache: 'reload' });
                if (imgRes && imgRes.ok) {
                  await cache.put(absUrl, imgRes);
                }
              }
            } catch (_err) {
              // Keep existing cached image if offline
            }
          })
        );
      }

      // 5. Commit all staged updates atomically to CACHE_NAME
      for (const item of stagedUpdates) {
        await cache.put(item.absUrl, item.response.clone());
        if (item.relPath === './index.html') {
          await cache.put(resolveScopeUrl('./'), item.response.clone());
        }
      }

      if (freshVersionText !== null) {
        const vHeaders = new Headers();
        vHeaders.set('content-type', (freshVersionHeaders && freshVersionHeaders.get('content-type')) || 'application/json; charset=utf-8');
        await cache.put(versionUrl, new Response(freshVersionText, { status: 200, headers: vHeaders }));
      }

      if (anyActualContentChanged) {
        await broadcastToClients({ type: 'APP_UPDATE_READY' });
        return { updated: true };
      }

      return { updated: false };
    } catch (_err) {
      return { updated: false, error: true };
    } finally {
      updateCheckPromise = null;
    }
  })();

  return updateCheckPromise;
}

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        const requests = PRECACHE_URLS.map(
          url => new Request(resolveScopeUrl(url), { cache: 'reload' })
        );
        return cache.addAll(requests);
      })
      .catch(err => console.error('Failed to cache app shell on install:', err))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(cacheNames =>
        Promise.all(
          cacheNames.map(cacheName => {
            if (cacheName !== CACHE_NAME && cacheName !== OCR_MODEL_CACHE) {
              return caches.delete(cacheName);
            }
            return Promise.resolve();
          })
        )
      )
      .then(() => self.clients.claim())
      .then(() => {
        // Non-blocking background warm of Tier 2 OCR models for 100% offline readiness
        warmOcrCache();
      })
  );
});

self.addEventListener('message', event => {
  const data = event.data;
  if (!data || !data.type) return;

  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (data.type === 'WARM_OFFLINE_CACHE') {
    event.waitUntil(warmOcrCache());
    return;
  }

  if (data.type === 'CHECK_FOR_UPDATES') {
    event.waitUntil(checkForAppUpdates(Boolean(data.force)));
  }
});

// Helper: Network-First with fast fallback to cache on error or slow connection
async function networkFirstWithTimeout(request, cleanUrl, timeoutMs = 3000) {
  const cache = await caches.open(CACHE_NAME);

  const fetchAndCache = fetch(request, { cache: 'no-cache' }).then(async networkResponse => {
    if (networkResponse && networkResponse.ok && networkResponse.type === 'basic') {
      const clone = networkResponse.clone();
      await cache.put(cleanUrl, clone);
      if (cleanUrl === resolveScopeUrl('./index.html')) {
        await cache.put(resolveScopeUrl('./'), networkResponse.clone());
      }
    }
    return networkResponse;
  });

  // Prevent unhandled rejection if timeout wins and fetch later fails offline
  fetchAndCache.catch(() => {});

  const cachedFallback = async () => {
    const exact = await cache.match(cleanUrl, { ignoreSearch: true });
    if (exact) return exact;
    const direct = await caches.match(request, { ignoreSearch: true });
    if (direct) return direct;
    if (request.mode === 'navigate') {
      const indexFallback = await cache.match(resolveScopeUrl('./index.html'), { ignoreSearch: true });
      if (indexFallback) return indexFallback;
    }
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  };

  try {
    const response = await Promise.race([
      fetchAndCache,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs))
    ]);
    if (response && response.ok) {
      return response;
    }
    return await cachedFallback();
  } catch (_err) {
    return await cachedFallback();
  }
}

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const requestUrl = new URL(event.request.url);
  // Only intercept same-origin requests
  if (requestUrl.origin !== self.location.origin) return;

  const pathname = requestUrl.pathname;
  if (pathname.startsWith('/api/')) return;
  const cleanUrl = getCleanCacheUrl(event.request.url);

  // 1. version.json: Always try network no-store first, fall back to cache when offline
  if (pathname.endsWith('/version.json')) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' })
        .then(async res => {
          if (res && res.ok) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(cleanUrl, res.clone());
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(cleanUrl, { ignoreSearch: true });
          return cached || new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
        })
    );
    return;
  }

  // 2. OCR models & WASM assets: Cache-First (dedicated Tier 2 cache)
  if (pathname.includes('/assets/ocr/')) {
    event.respondWith(
      caches.open(OCR_MODEL_CACHE).then(async ocrCache => {
        const hit =
          (await ocrCache.match(cleanUrl, { ignoreSearch: true })) ||
          (await caches.match(cleanUrl, { ignoreSearch: true }));
        if (hit) return hit;

        try {
          const networkResponse = await fetch(event.request);
          if (networkResponse && networkResponse.ok) {
            ocrCache.put(cleanUrl, networkResponse.clone());
          }
          return networkResponse;
        } catch (_err) {
          return new Response('Offline OCR asset unavailable', { status: 503, statusText: 'Offline' });
        }
      })
    );
    return;
  }

  // 3. Static image assets: Cache-First with network populate
  if (pathname.includes('/assets/') && /\.(png|jpe?g|webp|svg|ico)$/i.test(pathname)) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async cache => {
        const hit = await cache.match(cleanUrl, { ignoreSearch: true });
        if (hit) return hit;

        try {
          const networkResponse = await fetch(event.request);
          if (networkResponse && networkResponse.ok) {
            cache.put(cleanUrl, networkResponse.clone());
          }
          return networkResponse;
        } catch (_err) {
          return new Response('', { status: 503, statusText: 'Offline' });
        }
      })
    );
    return;
  }

  // 4. HTML pages, JS, CSS, manifest, and navigations: Network-First with fast cache fallback
  event.respondWith(networkFirstWithTimeout(event.request, cleanUrl, 3000));
});