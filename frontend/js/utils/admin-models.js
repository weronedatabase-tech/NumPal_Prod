// ==========================================
// admin-models.js - Hidden Admin AI Model Selector (GAS Script Properties)
// Long-press the Organisation Logo for 3 seconds to authenticate against
// GAS Script Property "AI_Model_Change" and configure Main ("GEMINI_FLASH_MODEL")
// & Backup ("GEMINI_FALLBACK_MODEL") free Gemini / Gemma models fetched live from Google.
// ==========================================

(function () {
  'use strict';

  const LONG_PRESS_MS = 3000;
  const MOVE_CANCEL_PX = 24;

  // Ephemeral in-memory session state (cleared on modal close, never stored in Web Storage)
  let adminToken = null;
  let availableModels = [];
  let currentMainModel = '';
  let currentBackupModel = '';
  let selectedMainModel = '';
  let selectedBackupModel = '';
  let openDropdownKey = null; // 'main' | 'backup' | null
  let isBusy = false;

  // Minimalist outline SVG icon helpers (static trusted markup only)
  const ICON_EYE_OPEN =
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/>' +
    '<circle cx="12" cy="12" r="3"/>' +
    '</svg>';

  const ICON_EYE_OFF =
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/>' +
    '<path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c6.5 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/>' +
    '<path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3.5 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/>' +
    '<line x1="2" y1="2" x2="22" y2="22"/>' +
    '</svg>';

  const ICON_CHEVRON =
    '<svg class="admin-select-chevron" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<polyline points="6 9 12 15 18 9"/>' +
    '</svg>';

  const ICON_CHECK =
    '<svg class="admin-option-check" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<polyline points="20 6 9 17 4 12"/>' +
    '</svg>';

  const ICON_CLOSE =
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<line x1="18" y1="6" x2="6" y2="18"/>' +
    '<line x1="6" y1="6" x2="18" y2="18"/>' +
    '</svg>';

  // ==========================================
  // Google Apps Script Backend Communication
  // ==========================================
  function getConfiguredGasApiUrl() {
    if (typeof API_URL !== 'string') return '';
    const trimmed = API_URL.trim();
    return /^https:\/\/.+/i.test(trimmed) ? trimmed : '';
  }

  async function postToGas(payload) {
    const gasUrl = getConfiguredGasApiUrl();
    if (!gasUrl) {
      throw new Error('Google Apps Script URL is not configured in backend/config.js.');
    }

    // Use text/plain for CORS simple request compatibility with Google Apps Script
    const res = await fetch(gasUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8'
      },
      redirect: 'follow',
      body: JSON.stringify(payload)
    });

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (_err) {
      throw new Error('GAS backend returned an unexpected response. Deploy the latest backend/Code.js.');
    }

    if (!res.ok || !data || data.ok === false) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.authExpired = Boolean(data && data.authExpired);
      throw err;
    }
    return data;
  }

  function apiAuthenticate(password) {
    return postToGas({ action: 'admin_auth', password });
  }

  function apiRefreshModels() {
    return postToGas({ action: 'admin_refresh_models', adminToken });
  }

  function apiUpdateModels(mainModel, backupModel) {
    return postToGas({
      action: 'admin_update_models',
      adminToken,
      mainModel,
      backupModel
    });
  }

  // ==========================================
  // DOM Creation & Safe Rendering
  // ==========================================
  let modalBackdrop = null;

  function ensureModalRoot() {
    if (modalBackdrop) return modalBackdrop;

    modalBackdrop = document.createElement('div');
    modalBackdrop.id = 'admin-model-backdrop';
    modalBackdrop.className = 'admin-modal-backdrop';
    modalBackdrop.setAttribute('aria-hidden', 'true');

    modalBackdrop.innerHTML =
      '<div class="admin-modal-card" role="dialog" aria-modal="true" aria-labelledby="admin-modal-title">' +
      '  <div class="admin-modal-header">' +
      '    <h2 id="admin-modal-title" class="admin-modal-title">Admin Access</h2>' +
      '    <button type="button" id="admin-modal-close" class="admin-close-btn" aria-label="Close">' +
      ICON_CLOSE +
      '    </button>' +
      '  </div>' +
      '  <div id="admin-auth-view" class="admin-modal-body">' +
      '    <p id="admin-auth-subtitle" class="admin-modal-subtitle">Enter the administrator password to configure expiration date scanning models.</p>' +
      '    <form id="admin-auth-form" autocomplete="off">' +
      '      <label for="admin-password-input" class="admin-field-label">Password</label>' +
      '      <div class="admin-password-wrap">' +
      '        <input type="password" id="admin-password-input" class="admin-password-input" placeholder="Enter password" autocomplete="current-password" required />' +
      '        <button type="button" id="admin-password-toggle" class="admin-eye-toggle" aria-label="Show password" aria-pressed="false">' +
      ICON_EYE_OPEN +
      '        </button>' +
      '      </div>' +
      '      <p id="admin-auth-error" class="admin-inline-error" role="alert" style="display: none;"></p>' +
      '      <div class="admin-modal-footer">' +
      '        <button type="submit" id="admin-enter-btn" class="primary-btn admin-submit-btn">Enter Settings</button>' +
      '      </div>' +
      '    </form>' +
      '  </div>' +
      '  <div id="admin-settings-view" class="admin-modal-body" style="display: none;">' +
      '    <div class="admin-model-field" data-field="main">' +
      '      <label class="admin-field-label" id="label-main-model">Main AI Model</label>' +
      '      <button type="button" id="trigger-main-model" class="admin-select-trigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="label-main-model">' +
      '        <span class="admin-select-value">' +
      '          <span id="main-model-name" class="admin-select-name"></span>' +
      '          <span id="main-model-id" class="admin-select-id"></span>' +
      '        </span>' +
      ICON_CHEVRON +
      '      </button>' +
      '      <div id="dropdown-main-model" class="admin-dropdown-list" role="listbox" aria-labelledby="label-main-model" style="display: none;"></div>' +
      '    </div>' +
      '    <div class="admin-model-field" data-field="backup">' +
      '      <label class="admin-field-label" id="label-backup-model">Backup AI Model</label>' +
      '      <button type="button" id="trigger-backup-model" class="admin-select-trigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="label-backup-model">' +
      '        <span class="admin-select-value">' +
      '          <span id="backup-model-name" class="admin-select-name"></span>' +
      '          <span id="backup-model-id" class="admin-select-id"></span>' +
      '        </span>' +
      ICON_CHEVRON +
      '      </button>' +
      '      <div id="dropdown-backup-model" class="admin-dropdown-list" role="listbox" aria-labelledby="label-backup-model" style="display: none;"></div>' +
      '    </div>' +
      '    <div class="admin-catalog-meta">' +
      '      <span id="admin-catalog-summary"></span>' +
      '      <span aria-hidden="true">·</span>' +
      '      <button type="button" id="admin-refresh-models-btn" class="admin-text-link">Refresh list</button>' +
      '    </div>' +
      '    <p id="admin-settings-error" class="admin-inline-error" role="alert" style="display: none;"></p>' +
      '    <div class="admin-modal-footer">' +
      '      <button type="button" id="admin-update-btn" class="primary-btn admin-submit-btn">Update Models</button>' +
      '    </div>' +
      '  </div>' +
      '</div>';

    document.body.appendChild(modalBackdrop);
    bindModalEvents();
    return modalBackdrop;
  }

  function findModelById(modelId) {
    for (let i = 0; i < availableModels.length; i++) {
      if (availableModels[i].id === modelId) return availableModels[i];
    }
    return null;
  }

  function renderSelectedField(fieldKey, modelId) {
    const nameEl = document.getElementById(fieldKey === 'main' ? 'main-model-name' : 'backup-model-name');
    const idEl = document.getElementById(fieldKey === 'main' ? 'main-model-id' : 'backup-model-id');
    if (!nameEl || !idEl) return;

    const match = findModelById(modelId);
    if (match) {
      nameEl.textContent = match.displayName;
      idEl.textContent = match.id;
    } else if (modelId) {
      nameEl.textContent = modelId;
      idEl.textContent = 'Currently configured';
    } else {
      nameEl.textContent = 'Select a model';
      idEl.textContent = '';
    }
  }

  function renderDropdownOptions(fieldKey) {
    const listEl = document.getElementById(
      fieldKey === 'main' ? 'dropdown-main-model' : 'dropdown-backup-model'
    );
    if (!listEl) return;

    const selectedId = fieldKey === 'main' ? selectedMainModel : selectedBackupModel;
    const activeInUseId = fieldKey === 'main' ? currentMainModel : currentBackupModel;

    while (listEl.firstChild) {
      listEl.removeChild(listEl.firstChild);
    }

    if (!availableModels.length) {
      const empty = document.createElement('div');
      empty.className = 'admin-dropdown-empty';
      empty.textContent = 'No free Gemini or Gemma models were returned by Google.';
      listEl.appendChild(empty);
      return;
    }

    const geminiModels = availableModels.filter(m => m.family === 'gemini');
    const gemmaModels = availableModels.filter(m => m.family === 'gemma');

    function appendGroup(groupLabel, items) {
      if (!items.length) return;
      const heading = document.createElement('div');
      heading.className = 'admin-dropdown-group';
      heading.textContent = groupLabel;
      listEl.appendChild(heading);

      items.forEach(item => {
        const isSelected = item.id === selectedId;
        const isCurrent = item.id === activeInUseId;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'admin-dropdown-option' + (isSelected ? ' selected' : '');
        btn.setAttribute('role', 'option');
        btn.setAttribute('aria-selected', isSelected ? 'true' : 'false');
        btn.dataset.modelId = item.id;

        const textWrap = document.createElement('span');
        textWrap.className = 'admin-option-text';

        const titleRow = document.createElement('span');
        titleRow.className = 'admin-option-name';
        titleRow.textContent = item.displayName;

        const idRow = document.createElement('span');
        idRow.className = 'admin-option-id';
        idRow.textContent = isCurrent ? `${item.id} · In use` : item.id;

        textWrap.appendChild(titleRow);
        textWrap.appendChild(idRow);
        btn.appendChild(textWrap);

        if (isSelected) {
          const checkWrap = document.createElement('span');
          checkWrap.className = 'admin-option-check-wrap';
          checkWrap.innerHTML = ICON_CHECK;
          btn.appendChild(checkWrap);
        }

        btn.addEventListener('click', e => {
          e.stopPropagation();
          if (fieldKey === 'main') {
            selectedMainModel = item.id;
          } else {
            selectedBackupModel = item.id;
          }
          renderSelectedField(fieldKey, item.id);
          closeDropdowns();
        });

        listEl.appendChild(btn);
      });
    }

    appendGroup('Gemini — Free Tier', geminiModels);
    appendGroup('Gemma — Free Tier', gemmaModels);
  }

  function closeDropdowns() {
    openDropdownKey = null;
    ['main', 'backup'].forEach(key => {
      const trigger = document.getElementById(`trigger-${key}-model`);
      const dropdown = document.getElementById(`dropdown-${key}-model`);
      if (trigger) {
        trigger.setAttribute('aria-expanded', 'false');
        trigger.classList.remove('open');
      }
      if (dropdown) {
        dropdown.style.display = 'none';
      }
    });
  }

  function toggleDropdown(fieldKey) {
    if (isBusy) return;
    if (openDropdownKey === fieldKey) {
      closeDropdowns();
      return;
    }

    closeDropdowns();
    openDropdownKey = fieldKey;
    renderDropdownOptions(fieldKey);

    const trigger = document.getElementById(`trigger-${fieldKey}-model`);
    const dropdown = document.getElementById(`dropdown-${fieldKey}-model`);
    if (trigger) {
      trigger.setAttribute('aria-expanded', 'true');
      trigger.classList.add('open');
    }
    if (dropdown) {
      dropdown.style.display = 'block';
      const selectedEl = dropdown.querySelector('.admin-dropdown-option.selected');
      if (selectedEl && typeof selectedEl.scrollIntoView === 'function') {
        selectedEl.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  function setInlineError(elementId, message) {
    const el = document.getElementById(elementId);
    if (!el) return;
    if (message) {
      el.textContent = message;
      el.style.display = 'block';
    } else {
      el.textContent = '';
      el.style.display = 'none';
    }
  }

  function updateCatalogSummary() {
    const summaryEl = document.getElementById('admin-catalog-summary');
    if (!summaryEl) return;
    const count = availableModels.length;
    summaryEl.textContent =
      count === 1
        ? '1 free model fetched live from Google'
        : `${count} free models fetched live from Google`;
  }

  function showAuthView() {
    const titleEl = document.getElementById('admin-modal-title');
    const authView = document.getElementById('admin-auth-view');
    const settingsView = document.getElementById('admin-settings-view');
    const passInput = document.getElementById('admin-password-input');
    const toggleBtn = document.getElementById('admin-password-toggle');
    const enterBtn = document.getElementById('admin-enter-btn');

    if (titleEl) titleEl.textContent = 'Admin Access';
    if (authView) authView.style.display = 'flex';
    if (settingsView) settingsView.style.display = 'none';

    if (passInput) {
      passInput.value = '';
      passInput.type = 'password';
    }
    if (toggleBtn) {
      toggleBtn.innerHTML = ICON_EYE_OPEN;
      toggleBtn.setAttribute('aria-label', 'Show password');
      toggleBtn.setAttribute('aria-pressed', 'false');
    }
    if (enterBtn) {
      enterBtn.disabled = false;
      enterBtn.textContent = 'Enter Settings';
    }

    setInlineError('admin-auth-error', '');
    setInlineError('admin-settings-error', '');
    closeDropdowns();

    setTimeout(() => {
      if (passInput) passInput.focus();
    }, 60);
  }

  function showSettingsView() {
    const titleEl = document.getElementById('admin-modal-title');
    const authView = document.getElementById('admin-auth-view');
    const settingsView = document.getElementById('admin-settings-view');
    const updateBtn = document.getElementById('admin-update-btn');

    if (titleEl) titleEl.textContent = 'AI Model Selection for Expiration Date Scanning';
    if (authView) authView.style.display = 'none';
    if (settingsView) settingsView.style.display = 'flex';
    if (updateBtn) {
      updateBtn.disabled = false;
      updateBtn.textContent = 'Update Models';
    }

    setInlineError('admin-settings-error', '');
    closeDropdowns();
    renderSelectedField('main', selectedMainModel);
    renderSelectedField('backup', selectedBackupModel);
    updateCatalogSummary();
  }

  function openAdminModal() {
    if (!navigator.onLine) {
      if (typeof window.showToast === 'function') {
        window.showToast('Connect to the internet to change AI models.', true);
      }
      return;
    }

    ensureModalRoot();
    adminToken = null;
    isBusy = false;
    showAuthView();

    modalBackdrop.classList.add('open');
    modalBackdrop.setAttribute('aria-hidden', 'false');
    if (typeof window.numpalSetBusy === 'function') {
      window.numpalSetBusy(true);
    }
  }

  function closeAdminModal() {
    if (!modalBackdrop) return;
    const wasOpen = modalBackdrop.classList.contains('open');
    modalBackdrop.classList.remove('open');
    modalBackdrop.setAttribute('aria-hidden', 'true');
    closeDropdowns();

    adminToken = null;
    isBusy = false;
    const passInput = document.getElementById('admin-password-input');
    if (passInput) passInput.value = '';

    if (wasOpen && typeof window.numpalSetBusy === 'function') {
      window.numpalSetBusy(false);
    }
  }

  function bindModalEvents() {
    const closeBtn = document.getElementById('admin-modal-close');
    const authForm = document.getElementById('admin-auth-form');
    const passInput = document.getElementById('admin-password-input');
    const toggleBtn = document.getElementById('admin-password-toggle');
    const enterBtn = document.getElementById('admin-enter-btn');
    const mainTrigger = document.getElementById('trigger-main-model');
    const backupTrigger = document.getElementById('trigger-backup-model');
    const refreshBtn = document.getElementById('admin-refresh-models-btn');
    const updateBtn = document.getElementById('admin-update-btn');

    if (closeBtn) {
      closeBtn.addEventListener('click', closeAdminModal);
    }

    modalBackdrop.addEventListener('click', e => {
      if (e.target === modalBackdrop) {
        closeAdminModal();
        return;
      }
      if (openDropdownKey && !e.target.closest('.admin-model-field')) {
        closeDropdowns();
      }
    });

    document.addEventListener('keydown', e => {
      if (!modalBackdrop || !modalBackdrop.classList.contains('open')) return;
      if (e.key === 'Escape') {
        if (openDropdownKey) {
          closeDropdowns();
        } else {
          closeAdminModal();
        }
      }
    });

    // Minimalist eye outline reveal/hide toggle
    if (toggleBtn && passInput) {
      toggleBtn.addEventListener('click', () => {
        const isHidden = passInput.type === 'password';
        passInput.type = isHidden ? 'text' : 'password';
        toggleBtn.innerHTML = isHidden ? ICON_EYE_OFF : ICON_EYE_OPEN;
        toggleBtn.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
        toggleBtn.setAttribute('aria-pressed', isHidden ? 'true' : 'false');
        passInput.focus();
      });
    }

    // Authenticate against GAS Script Property "AI_Model_Change" and fetch live models
    if (authForm) {
      authForm.addEventListener('submit', async e => {
        e.preventDefault();
        if (isBusy) return;

        const password = passInput ? passInput.value : '';
        if (!password) {
          setInlineError('admin-auth-error', 'Please enter the password.');
          return;
        }

        isBusy = true;
        setInlineError('admin-auth-error', '');
        if (enterBtn) {
          enterBtn.disabled = true;
          enterBtn.textContent = 'Verifying...';
        }

        try {
          const data = await apiAuthenticate(password);
          adminToken = data.adminToken || null;
          availableModels = Array.isArray(data.models) ? data.models : [];
          currentMainModel = String(data.currentMainModel || '').trim();
          currentBackupModel = String(data.currentBackupModel || '').trim();
          selectedMainModel = currentMainModel;
          selectedBackupModel = currentBackupModel;

          if (passInput) passInput.value = '';
          showSettingsView();
        } catch (err) {
          setInlineError('admin-auth-error', (err && err.message) || 'Authentication failed.');
        } finally {
          isBusy = false;
          if (enterBtn) {
            enterBtn.disabled = false;
            enterBtn.textContent = 'Enter Settings';
          }
        }
      });
    }

    if (mainTrigger) {
      mainTrigger.addEventListener('click', e => {
        e.stopPropagation();
        toggleDropdown('main');
      });
    }

    if (backupTrigger) {
      backupTrigger.addEventListener('click', e => {
        e.stopPropagation();
        toggleDropdown('backup');
      });
    }

    if (refreshBtn) {
      refreshBtn.addEventListener('click', async () => {
        if (isBusy) return;
        isBusy = true;
        closeDropdowns();
        setInlineError('admin-settings-error', '');
        refreshBtn.disabled = true;
        refreshBtn.textContent = 'Refreshing...';

        try {
          const data = await apiRefreshModels();
          availableModels = Array.isArray(data.models) ? data.models : [];
          currentMainModel = String(data.currentMainModel || currentMainModel).trim();
          currentBackupModel = String(data.currentBackupModel || currentBackupModel).trim();
          renderSelectedField('main', selectedMainModel);
          renderSelectedField('backup', selectedBackupModel);
          updateCatalogSummary();
        } catch (err) {
          if (err && err.authExpired) {
            adminToken = null;
            showAuthView();
            setInlineError('admin-auth-error', err.message || 'Session expired.');
          } else {
            setInlineError('admin-settings-error', (err && err.message) || 'Could not refresh models.');
          }
        } finally {
          isBusy = false;
          refreshBtn.disabled = false;
          refreshBtn.textContent = 'Refresh list';
        }
      });
    }

    if (updateBtn) {
      updateBtn.addEventListener('click', async () => {
        if (isBusy) return;
        if (!selectedMainModel || !selectedBackupModel) {
          setInlineError('admin-settings-error', 'Please select both a Main AI Model and a Backup AI Model.');
          return;
        }

        isBusy = true;
        closeDropdowns();
        setInlineError('admin-settings-error', '');
        updateBtn.disabled = true;
        updateBtn.textContent = 'Updating...';

        try {
          await apiUpdateModels(selectedMainModel, selectedBackupModel);
          closeAdminModal();
          if (typeof window.showToast === 'function') {
            window.showToast('AI models updated successfully!');
          }
        } catch (err) {
          if (err && err.authExpired) {
            adminToken = null;
            showAuthView();
            setInlineError('admin-auth-error', err.message || 'Session expired.');
          } else {
            setInlineError('admin-settings-error', (err && err.message) || 'Failed to update models.');
          }
        } finally {
          isBusy = false;
          if (updateBtn) {
            updateBtn.disabled = false;
            updateBtn.textContent = 'Update Models';
          }
        }
      });
    }
  }

  // ==========================================
  // Hidden 3-Second Long Press on Metta School Logo
  // ==========================================
  function attachLogoLongPress() {
    const logo = document.getElementById('org-logo');
    if (!logo) return;

    let pressTimer = null;
    let startX = 0;
    let startY = 0;
    let activePointerId = null;

    function cancelPress() {
      if (pressTimer !== null) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
      activePointerId = null;
    }

    logo.addEventListener('contextmenu', e => {
      e.preventDefault();
    });

    logo.addEventListener('dragstart', e => {
      e.preventDefault();
    });

    logo.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      cancelPress();
      activePointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;

      pressTimer = setTimeout(() => {
        pressTimer = null;
        activePointerId = null;
        if (navigator.vibrate) {
          try {
            navigator.vibrate(35);
          } catch (_err) {}
        }
        openAdminModal();
      }, LONG_PRESS_MS);
    });

    logo.addEventListener('pointermove', e => {
      if (pressTimer === null || e.pointerId !== activePointerId) return;
      const dist = Math.hypot(e.clientX - startX, e.clientY - startY);
      if (dist > MOVE_CANCEL_PX) {
        cancelPress();
      }
    });

    logo.addEventListener('pointerup', cancelPress);
    logo.addEventListener('pointercancel', cancelPress);
    logo.addEventListener('pointerleave', cancelPress);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attachLogoLongPress);
  } else {
    attachLogoLongPress();
  }
})();
