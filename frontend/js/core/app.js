// ==========================================
// app.js - Global Initialization, Auto-Update Engine, PWA Install & Offline Handling
// ==========================================

const appHeight = () => {
  const doc = document.documentElement;
  doc.style.setProperty('--app-height', `${window.innerHeight}px`);
};
window.addEventListener('resize', appHeight);
window.addEventListener('orientationchange', appHeight);
appHeight();

// Clean up any leftover ?update= cache-buster param from backup force updates
(function cleanUpdateQueryParam() {
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.has('update')) {
      url.searchParams.delete('update');
      const cleanHref = url.pathname + (url.search || '') + (url.hash || '');
      window.history.replaceState({}, document.title, cleanHref);
    }
  } catch (_err) {
    // Ignore history API restrictions
  }
})();

// Environment Banner Injection
window.addEventListener('DOMContentLoaded', () => {
  if (typeof ENV !== 'undefined' && (ENV === 'Dev' || ENV === 'Exp')) {
    const banner = document.createElement('div');
    banner.textContent = ENV === 'Dev' ? 'Testing' : 'Experimentation';
    banner.style.backgroundColor = ENV === 'Dev' ? '#d32f2f' : '#9C27B0';
    banner.style.color = '#ffffff';
    banner.style.textAlign = 'center';
    banner.style.padding = '4px';
    banner.style.fontWeight = 'bold';
    banner.style.fontSize = '0.85rem';
    banner.style.letterSpacing = '1px';
    banner.style.textTransform = 'uppercase';
    banner.style.flexShrink = '0';
    banner.style.zIndex = '99999';
    document.body.insertBefore(banner, document.body.firstChild);
  }
});

// Theme Toggle
const themeToggle = document.getElementById('theme-toggle');
const currentTheme = localStorage.getItem('theme') || 'light';
if (currentTheme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');

if (themeToggle) {
  themeToggle.addEventListener('click', () => {
    const theme = document.documentElement.getAttribute('data-theme');
    if (theme === 'dark') {
      document.documentElement.removeAttribute('data-theme');
      localStorage.setItem('theme', 'light');
    } else {
      document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem('theme', 'dark');
    }
  });
}

// ==========================================
// Busy-State & Safe Auto-Update Reload Manager
// ==========================================
let isReloadingForUpdate = false;
let pendingAutoReload = false;
let explicitBusyCount = 0;

function isUserActivelyBusy() {
  if (explicitBusyCount > 0) return true;
  const cameraModal = document.getElementById('camera-modal');
  if (cameraModal && cameraModal.classList.contains('open')) return true;
  const processingScreen = document.getElementById('processing-screen');
  if (processingScreen && processingScreen.style.display === 'flex') return true;
  return false;
}

function triggerAutoUpdateReload() {
  if (isReloadingForUpdate) return;

  // Anti-loop guard: never auto-reload more than once within 10 seconds
  const lastReload = Number(sessionStorage.getItem('numpalLastAutoReload') || '0');
  if (Date.now() - lastReload < 10000) return;

  if (isUserActivelyBusy()) {
    if (!pendingAutoReload) {
      pendingAutoReload = true;
      if (typeof window.showToast === 'function') {
        window.showToast('New version ready — updating as soon as you finish.');
      }
    }
    return;
  }

  isReloadingForUpdate = true;
  pendingAutoReload = false;
  sessionStorage.setItem('numpalLastAutoReload', String(Date.now()));
  sessionStorage.setItem('appUpdated', 'true');

  if (typeof window.showToast === 'function') {
    window.showToast('Updating to the latest version...');
  }

  setTimeout(() => {
    window.location.reload();
  }, 350);
}

window.numpalSetBusy = function (busy) {
  if (busy) {
    explicitBusyCount++;
  } else {
    explicitBusyCount = Math.max(0, explicitBusyCount - 1);
    if (pendingAutoReload && !isUserActivelyBusy()) {
      triggerAutoUpdateReload();
    }
  }
};

// ==========================================
// Service Worker Registration & Auto-Update Detection
// ==========================================
let swRegistration = null;

function resolveSwPath() {
  if (window.location.pathname.includes('/frontend/pages/')) {
    return '../../sw.js';
  }
  return './sw.js';
}

function postMessageToSw(message) {
  const target =
    (navigator.serviceWorker && navigator.serviceWorker.controller) ||
    (swRegistration && (swRegistration.active || swRegistration.waiting || swRegistration.installing));
  if (target) {
    target.postMessage(message);
  }
}

async function runAutoUpdateCheck(force = false) {
  if (!navigator.onLine || !('serviceWorker' in navigator)) return;

  try {
    if (swRegistration) {
      await swRegistration.update();
      if (swRegistration.waiting) {
        swRegistration.waiting.postMessage({ type: 'SKIP_WAITING' });
        return;
      }
    }
    postMessageToSw({ type: 'CHECK_FOR_UPDATES', force });
    postMessageToSw({ type: 'WARM_OFFLINE_CACHE' });
  } catch (_err) {
    // Silently ignore transient offline/network errors during background check
  }
}

if ('serviceWorker' in navigator) {
  const hadControllerAtBoot = Boolean(navigator.serviceWorker.controller);

  // Auto-reload when a new Service Worker takes control after an update
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadControllerAtBoot) {
      triggerAutoUpdateReload();
    }
  });

  // Listen for SW auto-update & offline-cache messages
  navigator.serviceWorker.addEventListener('message', event => {
    const msg = event.data;
    if (!msg || !msg.type) return;

    if (msg.type === 'APP_UPDATE_READY') {
      triggerAutoUpdateReload();
    } else if (msg.type === 'OCR_CACHE_READY') {
      window.dispatchEvent(new CustomEvent('numpal:ocr-cache-ready'));
    }
  });

  window.addEventListener('load', () => {
    const swPath = resolveSwPath();
    // updateViaCache: 'none' ensures GitHub Pages' HTTP cache never hides a new sw.js
    navigator.serviceWorker
      .register(swPath, { updateViaCache: 'none' })
      .then(reg => {
        swRegistration = reg;

        // If a waiting worker already exists, activate it right away
        if (reg.waiting) {
          reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        }

        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (!newWorker) return;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              newWorker.postMessage({ type: 'SKIP_WAITING' });
            }
          });
        });

        // Warm offline OCR cache & check for updates shortly after initial boot
        if (navigator.onLine) {
          setTimeout(() => {
            runAutoUpdateCheck(false);
          }, 1500);
        }
      })
      .catch(err => console.error('SW Registration Failed:', err));
  });

  // Re-check whenever user returns to the app or regains connectivity
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      runAutoUpdateCheck(false);
    }
  });

  window.addEventListener('focus', () => {
    runAutoUpdateCheck(false);
  });

  window.addEventListener('online', () => {
    runAutoUpdateCheck(true);
  });

  // Periodic background check every 60s while app is open & online
  setInterval(() => {
    if (document.visibilityState === 'visible' && navigator.onLine) {
      runAutoUpdateCheck(false);
    }
  }, 60000);
}

// ==========================================
// Backup Manual Force Update Handler
// ==========================================
const forceUpdateBtn = document.getElementById('force-update-btn');
if (forceUpdateBtn) {
  forceUpdateBtn.addEventListener('click', async () => {
    if (!navigator.onLine) {
      if (typeof window.showToast === 'function') {
        window.showToast('Currently offline. Connect to the internet to force update.', true);
      }
      return;
    }

    const icon = forceUpdateBtn.querySelector('.update-icon');
    if (icon) icon.classList.add('spin');
    if (typeof window.showToast === 'function') {
      window.showToast('Refreshing app & clearing cache...');
    }

    try {
      await new Promise(resolve => setTimeout(resolve, 600));
      if ('caches' in window) {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames.map(name => caches.delete(name)));
      }
      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map(reg => reg.unregister()));
      }
      sessionStorage.setItem('appUpdated', 'true');
      sessionStorage.setItem('numpalLastAutoReload', String(Date.now()));
      const cacheBuster = '?update=' + Date.now();
      window.location.replace(window.location.pathname + cacheBuster);
    } catch (_err) {
      if (icon) icon.classList.remove('spin');
      if (typeof window.showToast === 'function') {
        window.showToast('Update failed. Check your connection.', true);
      }
    }
  });
}

// ==========================================
// In-App PWA Install Prompt (Chromium/Android/Desktop + iOS Safari)
// ==========================================
let deferredInstallPrompt = null;

function isStandaloneMode() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  );
}

function isIOSDevice() {
  const ua = window.navigator.userAgent || '';
  const isStandardIOS = /iphone|ipad|ipod/i.test(ua);
  // iPadOS 13+ reports a desktop Macintosh user agent with multi-touch support
  const isIPadOSDesktopUA =
    window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1;
  return isStandardIOS || isIPadOSDesktopUA;
}

function isIOSChrome() {
  return /CriOS/i.test(window.navigator.userAgent || '');
}

function showIOSInstallModal() {
  let modal = document.getElementById('ios-install-modal');
  if (!modal) {
    const shareIconSvg = `<svg class="ios-share-icon" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>`;
    const shareLocation = isIOSChrome()
      ? 'in the top-right address bar'
      : 'in Safari\u2019s toolbar';

    modal = document.createElement('div');
    modal.id = 'ios-install-modal';
    modal.className = 'pwa-modal-backdrop';
    modal.innerHTML = `
      <div class="pwa-modal-card" role="dialog" aria-modal="true" aria-labelledby="ios-install-title">
        <h3 id="ios-install-title">Install NumPal on iPhone / iPad</h3>
        <p>Add NumPal to your home screen so it launches full-screen and works 100% offline:</p>
        <ol>
          <li>Tap the <strong>Share</strong> button ${shareIconSvg} ${shareLocation}.</li>
          <li>Scroll down and tap <strong>Add to Home Screen</strong>.</li>
          <li>Tap <strong>Add</strong> in the top-right corner.</li>
        </ol>
        <p style="font-size: 0.85rem; opacity: 0.7; margin-bottom: 1rem;">Tip: If you don\u2019t see \u201CAdd to Home Screen\u201D, open this link in <strong>Safari</strong> first.</p>
        <button type="button" class="primary-btn" id="ios-install-close">Got it</button>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => {
      if (e.target === modal) modal.classList.remove('open');
    });
    modal.querySelector('#ios-install-close').addEventListener('click', () => {
      modal.classList.remove('open');
    });
  }
  modal.classList.add('open');
}

function updateInstallButtonVisibility() {
  const installWrapper = document.getElementById('pwa-install-wrapper');
  const installBtn = document.getElementById('pwa-install-btn');
  if (!installBtn) return;

  if (isStandaloneMode()) {
    if (installWrapper) installWrapper.classList.remove('visible');
    else installBtn.style.display = 'none';
    return;
  }

  const shouldShow = Boolean(deferredInstallPrompt) || isIOSDevice();
  if (installWrapper) {
    installWrapper.classList.toggle('visible', shouldShow);
  } else {
    installBtn.style.display = shouldShow ? 'inline-flex' : 'none';
  }
}

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstallPrompt = e;
  updateInstallButtonVisibility();
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  updateInstallButtonVisibility();
  if (typeof window.showToast === 'function') {
    window.showToast('NumPal installed for offline use!');
  }
});

// ==========================================
// Offline Connectivity Indicator & Boot Toasts
// ==========================================
function ensureOfflineBanner() {
  const slot = document.getElementById('offline-pill-slot');
  if (!slot) return;

  let banner = document.getElementById('offline-status-pill');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'offline-status-pill';
    banner.className = 'offline-status-pill inline';
    banner.setAttribute('role', 'status');
    banner.innerHTML = '<span class="offline-dot"></span><span>Offline Mode</span>';
    slot.appendChild(banner);
  }
  const isOffline = !navigator.onLine;
  banner.classList.toggle('visible', isOffline);
  slot.classList.toggle('visible', isOffline);
}

window.addEventListener('online', () => {
  ensureOfflineBanner();
});

window.addEventListener('offline', () => {
  ensureOfflineBanner();
});

document.addEventListener('DOMContentLoaded', () => {
  ensureOfflineBanner();

  const installBtn = document.getElementById('pwa-install-btn');
  if (installBtn) {
    updateInstallButtonVisibility();
    installBtn.addEventListener('click', async () => {
      if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        try {
          const choice = await deferredInstallPrompt.userChoice;
          if (choice && choice.outcome === 'accepted') {
            deferredInstallPrompt = null;
            updateInstallButtonVisibility();
          }
        } catch (_err) {
          // Ignore dismissed prompt errors
        }
      } else if (isIOSDevice()) {
        showIOSInstallModal();
      }
    });
  }

  if (sessionStorage.getItem('appUpdated') === 'true') {
    sessionStorage.removeItem('appUpdated');
    setTimeout(() => {
      if (typeof window.showToast === 'function') {
        window.showToast('App updated to the latest version!');
      }
    }, 300);
  }
});