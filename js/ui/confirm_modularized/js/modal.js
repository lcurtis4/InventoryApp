// js/ui/confirm/modal.js
// -----------------------------------------------------------------------------
// Confirm modal open/close + confirm/cancel handlers
// -----------------------------------------------------------------------------
(function () {
  'use strict';

  const { state } = window.ConfirmUI || {};
  const { escapeHtml } = (window.ConfirmUI && window.ConfirmUI.utils) || {};
  const { addRowToRecentTable, seedRecentMapFromDomOnce } =
    (window.ConfirmUI && window.ConfirmUI.recent) || {};

  // =========================
  // Original module functions
  // =========================
  function openConfirmModal_legacy(row) {
    if (!state) {
      console.warn('[confirm] legacy modal state not available; use adapter.');
      return;
    }
    state.setPendingRow(row || null);

    const summaryEl = state.summaryEl;
    const pending = state.getPendingRow();
    if (summaryEl && pending && typeof escapeHtml === 'function') {
      summaryEl.innerHTML = `
        <div><strong>${escapeHtml(pending.name || '')}</strong></div>
        <div>${escapeHtml(pending.set || '')} • ${escapeHtml(pending.code || '')}</div>
        <div>${escapeHtml(pending.rarity || '')} • ${escapeHtml(pending.condition || '')}</div>
        <div>Qty: ${escapeHtml(String(pending.qty ?? 1))}</div>
      `;
    }

    const modalEl = state.modalEl;
    if (modalEl) {
      modalEl.style.display = 'block';
      modalEl.removeAttribute('aria-hidden');
      document.body.classList.add('modal-open');
    } else {
      console.warn('[confirm] modal root not found; proceeding without UI');
    }
  }

  function closeConfirmModal_legacy() {
    if (!state) return;
    const modalEl = state.modalEl;
    if (modalEl) {
      modalEl.style.display = 'none';
      modalEl.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('modal-open');
    }
    state.setPendingRow && state.setPendingRow(null);
  }

  function ensureDefaultPostHandler() {
    if (!state) return;
    if (typeof state.getPostHandler === 'function' && typeof state.getPostHandler() === 'function') return;

    if (typeof window.postCurrentSelection === 'function') {
      state.setPostHandler(window.postCurrentSelection);
      console.log('[confirm] Using default post handler: window.postCurrentSelection');
      return;
    }

    const candidates = ['postToSheet', 'postSelection', 'postRow', 'submitSelection'];
    for (const name of candidates) {
      if (typeof window[name] === 'function') {
        state.setPostHandler && state.setPostHandler(window[name]);
        console.log('[confirm] Using default post handler:', name);
        return;
      }
    }

    console.warn('[confirm] No post handler found. Use setConfirmPostHandler(fn).');
  }

  async function onConfirmClick_legacy() {
    if (!state) return;

    const pending = state.getPendingRow && state.getPendingRow();
    if (!pending) {
      console.warn('[confirm] nothing pending to post.');
      closeConfirmModal_legacy();
      return;
    }

    ensureDefaultPostHandler();

    try {
      const handler = state.getPostHandler && state.getPostHandler();
      if (typeof handler === 'function') {
        const res = await handler(pending);
        if (res === false) {
          console.warn('[confirm] post handler returned false; aborting recent update.');
          closeConfirmModal_legacy();
          return;
        }
      } else {
        console.warn('[confirm] No post handler set. Skipping sheet post.');
      }
    } catch (err) {
      console.error('[confirm] post handler threw:', err);
      closeConfirmModal_legacy();
      return;
    }

    if (typeof addRowToRecentTable === 'function') {
      addRowToRecentTable(pending);
    }

    try {
      if (typeof window.resetSelectionForm === 'function') {
        window.resetSelectionForm();
      } else if (typeof window.resetForm === 'function') {
        window.resetForm();
      }
    } catch (_) {}

    closeConfirmModal_legacy();
  }

  function onCancelClick_legacy() {
    closeConfirmModal_legacy();
  }

  function setConfirmPostHandler(fn) {
    if (typeof fn !== 'function') {
      console.warn('[confirm] setConfirmPostHandler expected a function, got:', typeof fn);
      return;
    }
    state && state.setPostHandler && state.setPostHandler(fn);
  }

  function init_legacy() {
    if (typeof seedRecentMapFromDomOnce === 'function') {
      seedRecentMapFromDomOnce();
    }

    if (state && state.btnYes) state.btnYes.addEventListener('click', onConfirmClick_legacy);
    if (state && state.btnNo)  state.btnNo.addEventListener('click', onCancelClick_legacy);

    const modalEl = state && state.modalEl;
    if (modalEl) {
      modalEl.addEventListener('click', (e) => {
        if (e.target === modalEl) closeConfirmModal_legacy();
      });
    }
  }

  window.ConfirmUI = window.ConfirmUI || {};
  window.ConfirmUI.modal = {
    openConfirmModal: openConfirmModal_legacy,
    closeConfirmModal: closeConfirmModal_legacy,
    onConfirmClick: onConfirmClick_legacy,
    onCancelClick: onCancelClick_legacy,
    ensureDefaultPostHandler,
    setConfirmPostHandler,
    init: init_legacy
  };

  // =========================================================
  // Adapter for controller: window.openConfirmModal({state,onConfirm})
  // Uses the modal markup that exists in index.html.
  // =========================================================
  (function attachAdapter() {
    const $ = (sel, root = document) => (root || document).querySelector(sel);

    // Elements from index.html
    const modalEl   = $('#codeConfirmModal');
    const textEl    = $('#codeConfirmText');
    const btnOk     = $('#codeConfirmConfirmBtn');
    const btnCancel = $('#codeConfirmCancelBtn');
    const btnX      = $('#codeConfirmCloseX');

    function show() {
      if (!modalEl) return;
      // prefer class-based show/hide used by your page
      modalEl.classList.remove('hidden');
      modalEl.setAttribute('aria-hidden', 'false');
    }
    function hide() {
      if (!modalEl) return;
      modalEl.classList.add('hidden');
      modalEl.setAttribute('aria-hidden', 'true');
    }

    function summarize(s = {}) {
      const parts = [];
      if (s.name) parts.push(`Name: ${s.name}`);
      if (s.setCode) parts.push(`Set: ${s.setCode}`);
      if (s.rarity) parts.push(`Rarity: ${s.rarity}`);
      if (s.condition) parts.push(`Condition: ${s.condition}`);
      if (s.qty) parts.push(`Qty: ${s.qty}`);
      return parts.join('  •  ');
    }

    // Public adapter
    window.openConfirmModal = function ({ state, onConfirm } = {}) {
      if (!modalEl) {
        console.error('[confirm] #codeConfirmModal not found in DOM.');
        return;
      }

      // Fill summary text
      if (textEl) textEl.textContent = `Confirm: ${summarize(state || {})}`;

      // Reset previous listeners by cloning
      [btnOk, btnCancel, btnX].forEach((b) => {
        if (!b || !b.parentNode) return;
        const clone = b.cloneNode(true);
        b.parentNode.replaceChild(clone, b);
      });

      // Re-acquire after cloning
      const ok = $('#codeConfirmConfirmBtn');
      const cancel = $('#codeConfirmCancelBtn');
      const x = $('#codeConfirmCloseX');

      ok && ok.addEventListener('click', async () => {
        hide();
        try {
          await onConfirm?.(state);
        } catch (e) {
          console.error('[confirm] onConfirm failed:', e);
        }
      });
      const close = () => hide();
      cancel && cancel.addEventListener('click', close);
      x && x.addEventListener('click', close);

      // Escape to close
      document.addEventListener(
        'keydown',
        function esc(e) {
          if (e.key === 'Escape') {
            hide();
            document.removeEventListener('keydown', esc);
          }
        },
        { once: true }
      );

      show();
    };
  })();
})();
