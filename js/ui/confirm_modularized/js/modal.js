// js/ui/confirm/modal.js
(function () {
  'use strict';

  // Version stamp to help you see which file "wins"
  var MODAL_VERSION = 3; // bump if you update this file
  console.info('[confirm] modal.js v' + MODAL_VERSION + ' loaded');

  const ConfirmUI = (window.ConfirmUI = window.ConfirmUI || {});
  const state = (ConfirmUI.state = ConfirmUI.state || {});
  const recent = (ConfirmUI.recent = ConfirmUI.recent || {});
  const addRowToRecentTable = recent.addRowToRecentTable || function () {};
  const seedRecentMapFromDomOnce = recent.seedRecentMapFromDomOnce || function () {};

  // ---------------------------
  // Password resolution helpers
  // ---------------------------
  function deepFindPassword(obj, depth) {
    depth = depth || 0;
    if (!obj || typeof obj !== 'object' || depth > 4) return null;

    if (Object.prototype.hasOwnProperty.call(obj, 'password')) {
      var v = obj.password;
      if (v != null && v !== '') return v;
    }
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      var val = obj[k];
      if (k === 'password' && val != null && val !== '') return val;
      if (val && typeof val === 'object') {
        var found = deepFindPassword(val, depth + 1);
        if (found != null && found !== '') return found;
      }
    }
    return null;
  }

  function getPendingRow() {
    try {
      if (typeof state.getPendingRow === 'function') return state.getPendingRow();
      return state.pendingRow || null;
    } catch (e) {
      return null;
    }
  }

  function resolvePasswordForConfirm(adapterState) {
    // 1) adapter param
    if (adapterState && adapterState.password != null && adapterState.password !== '') {
      return String(adapterState.password);
    }

    // 2) pending row (object or DOM node)
    var pending = getPendingRow();
    if (pending) {
      if (pending.password != null && pending.password !== '') return String(pending.password);
      if (pending.dataset && pending.dataset.password != null && pending.dataset.password !== '') {
        return String(pending.dataset.password);
      }
      var nested = deepFindPassword(pending);
      if (nested != null && nested !== '') return String(nested);
    }

    // 3) nested on adapter param
    var nestedA = deepFindPassword(adapterState);
    if (nestedA != null && nestedA !== '') return String(nestedA);

    // 4) optional global
    if (window.State) {
      if (window.State.password != null && window.State.password !== '') {
        return String(window.State.password);
      }
      var nestedG = deepFindPassword(window.State);
      if (nestedG != null && nestedG !== '') return String(nestedG);
    }

    return '(none)';
  }

  // ---------------------------
  // Legacy modal API (back-compat)
  // ---------------------------
  function openConfirmModal_legacy(row) {
    if (typeof state.setPendingRow === 'function') state.setPendingRow(row || null);

    var summaryEl = state.summaryEl;
    if (summaryEl) {
      summaryEl.textContent = 'Confirm: ' + resolvePasswordForConfirm(null);
    }

    var modalEl = state.modalEl;
    if (modalEl) {
      modalEl.style.display = 'block';
      modalEl.setAttribute('aria-hidden', 'false');
      document.body.classList.add('modal-open');
    }
  }

  function closeConfirmModal_legacy() {
    var modalEl = state && state.modalEl;
    if (modalEl) {
      modalEl.style.display = 'none';
      modalEl.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('modal-open');
    }
    if (typeof state.setPendingRow === 'function') state.setPendingRow(null);
  }

  function ensureDefaultPostHandler() {
    if (!state) return;
    if (typeof state.getPostHandler === 'function' && typeof state.getPostHandler() === 'function') return;

    if (typeof window.postCurrentSelection === 'function') {
      state.setPostHandler && state.setPostHandler(window.postCurrentSelection);
      return;
    }
    var candidates = ['postToSheet', 'postSelection', 'postRow', 'submitSelection'];
    for (var i = 0; i < candidates.length; i++) {
      var name = candidates[i];
      if (typeof window[name] === 'function') {
        state.setPostHandler && state.setPostHandler(window[name]);
        return;
      }
    }
  }

  async function onConfirmClick_legacy() {
    var pending = getPendingRow();
    if (!pending) {
      closeConfirmModal_legacy();
      return;
    }

    ensureDefaultPostHandler();

    try {
      var handler = state.getPostHandler && state.getPostHandler();
      if (typeof handler === 'function') {
        var res = await handler(pending);
        if (res === false) {
          closeConfirmModal_legacy();
          return;
        }
      }
    } catch (err) {
      console.error('[confirm] post handler error:', err);
      closeConfirmModal_legacy();
      return;
    }

    try { addRowToRecentTable(pending); } catch (e) {}
    try {
      if (typeof window.resetSelectionForm === 'function') window.resetSelectionForm();
      else if (typeof window.resetForm === 'function') window.resetForm();
    } catch (e) {}

    closeConfirmModal_legacy();
  }

  function onCancelClick_legacy() { closeConfirmModal_legacy(); }

  function init_legacy() {
    try { seedRecentMapFromDomOnce(); } catch (e) {}

    if (state && state.btnYes) state.btnYes.addEventListener('click', onConfirmClick_legacy);
    if (state && state.btnNo)  state.btnNo.addEventListener('click', onCancelClick_legacy);

    var modalEl = state && state.modalEl;
    if (modalEl) {
      modalEl.addEventListener('click', function (e) {
        if (e.target === modalEl) closeConfirmModal_legacy();
      });
    }
  }

  // Expose legacy API (we’ll lock openConfirmModal later)
  ConfirmUI.modal = ConfirmUI.modal || {};
  ConfirmUI.modal.closeConfirmModal = closeConfirmModal_legacy;
  ConfirmUI.modal.onConfirmClick = onConfirmClick_legacy;
  ConfirmUI.modal.onCancelClick = onCancelClick_legacy;
  ConfirmUI.modal.ensureDefaultPostHandler = ensureDefaultPostHandler;
  ConfirmUI.modal.init = init_legacy;

  // --------------------------------------------
  // Modern adapter: window.openConfirmModal(...)
  // --------------------------------------------
  (function attachAdapter() {
    var $ = function (sel, root) { return (root || document).querySelector(sel); };

    var modalEl   = $('#codeConfirmModal');
    var textEl    = $('#codeConfirmText');
    var btnOk     = $('#codeConfirmConfirmBtn');
    var btnCancel = $('#codeConfirmCancelBtn');
    var btnX      = $('#codeConfirmCloseX');

    function show() {
      if (!modalEl) return;
      modalEl.classList.remove('hidden');
      modalEl.setAttribute('aria-hidden', 'false');
    }
    function hide() {
      if (!modalEl) return;
      modalEl.classList.add('hidden');
      modalEl.setAttribute('aria-hidden', 'true');
    }

    function adapterOpen(opts) {
      opts = opts || {};
      var adapterState = opts.state || null;

      if (!modalEl) {
        console.error('[confirm] #codeConfirmModal not found.');
        return;
      }

      // *** Only the card code (password) ***
      if (textEl) {
        textEl.textContent = 'Confirm: ' + resolvePasswordForConfirm(adapterState);
      }

      // Reset previous listeners by cloning
      [btnOk, btnCancel, btnX].forEach(function (b) {
        if (!b || !b.parentNode) return;
        var clone = b.cloneNode(true);
        b.parentNode.replaceChild(clone, b);
      });

      // Re-acquire after cloning
      btnOk     = $('#codeConfirmConfirmBtn');
      btnCancel = $('#codeConfirmCancelBtn');
      btnX      = $('#codeConfirmCloseX');

      btnOk && btnOk.addEventListener('click', async function () {
        hide();
        try { await (opts.onConfirm && opts.onConfirm(adapterState)); }
        catch (e) { console.error('[confirm] onConfirm failed:', e); }
      });

      var close = function () { hide(); };
      btnCancel && btnCancel.addEventListener('click', close);
      btnX && btnX.addEventListener('click', close);

      document.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape') {
          hide();
          document.removeEventListener('keydown', esc);
        }
      }, { once: true });

      show();
    }

    // --- Lock both entry points so later scripts can't overwrite them ---
    try {
      Object.defineProperty(window, 'openConfirmModal', {
        value: adapterOpen, writable: false, configurable: false
      });
    } catch (e) {
      // fallback if already defined: still assign
      window.openConfirmModal = adapterOpen;
    }

    try {
      Object.defineProperty(ConfirmUI.modal, 'openConfirmModal', {
        value: openConfirmModal_legacy, writable: false, configurable: false
      });
    } catch (e) {
      ConfirmUI.modal.openConfirmModal = openConfirmModal_legacy;
    }
  })();

})();
