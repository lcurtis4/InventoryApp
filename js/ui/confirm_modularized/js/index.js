// js/ui/confirm_modularized/js/index.js
// Controller for the Confirm flow (classic script, not ESM).
// Adds robust fallbacks so the feature works even if modal/recent adapters aren't loaded.

(function () {
  // --- logging --------------------------------------------------------------
  const log  = (...a) => console.debug('[confirm]', ...a);
  const warn = (...a) => console.warn('[confirm]', ...a);
  const err  = (...a) => console.error('[confirm]', ...a);

  // --- helpers --------------------------------------------------------------
  function findPostBtn() {
    return (
      document.getElementById('postToSheet') ||
      document.getElementById('confirmBtn') ||
      document.querySelector('[data-action="post-to-sheet"]') ||
      document.querySelector('button#post-to-sheet, button.post-to-sheet')
    );
  }

  function norm(v){ return String(v ?? '').trim(); }
  function toInt(n, d = 1) {
    const v = parseInt(n, 10);
    return Number.isFinite(v) && v > 0 ? v : d;
  }

  // Build the payload we confirm + send to the sheet.
  // Sends canonical keys the sheet expects: { name, set, code, rarity, qty, condition }
  // Also includes aliases for compatibility with other call sites: setCode/printingCode/set_name/set_code
  function currentPayload() {
    const name =
      norm(document.getElementById('manualName')?.value) ||
      norm(document.getElementById('ocrName')?.value);

    const setEl   = document.getElementById('setSelect');
    const code    = norm(setEl?.value); // printing code from <option value="">
    const setText = setEl?.selectedOptions?.[0]?.textContent ?? '';
    // Prefer data attribute if you set it when building options; fall back to visible text
    const set     = norm(setEl?.selectedOptions?.[0]?.dataset?.setName ?? setText);

    const rarity    = norm(document.getElementById('raritySelect')?.value);
    const qty       = toInt(document.getElementById('qty')?.value || '1', 1);
    const condition = norm(document.getElementById('conditionSelect')?.value);

    // Canonical keys:
    const row = { name, set, code, rarity, qty, condition };

    // Backward / side-compatibility:
    row.setCode      = code;
    row.printingCode = code;
    row.set_name     = set;
    row.set_code     = code;

    return row;
  }

  // --- modal (adapter + fallback) ------------------------------------------
  function summarize(s = {}) {
    const parts = [];
    if (s.name) parts.push(`Name: ${s.name}`);
    if (s.set) parts.push(`Set: ${s.set}`);
    if (s.setCode) parts.push(`Set: ${s.setCode}`);
    if (s.rarity) parts.push(`Rarity: ${s.rarity}`);
    if (s.condition) parts.push(`Condition: ${s.condition}`);
    if (s.qty) parts.push(`Qty: ${s.qty}`);
    return parts.join('  •  ');
  }

  function ensureModalAndOpen({ state, onConfirm }) {
    // Prefer app adapter if present
    if (typeof window.openConfirmModal === 'function') {
      log('Using app modal adapter');
      window.openConfirmModal({ state, onConfirm });
      return;
    }

    // Try markup in index.html if present (#codeConfirmModal)
    const modalEl = document.getElementById('codeConfirmModal');
    const textEl  = document.getElementById('codeConfirmText');
    const okBtn   = document.getElementById('codeConfirmConfirmBtn');
    const cancel  = document.getElementById('codeConfirmCancelBtn');
    const closeX  = document.getElementById('codeConfirmCloseX');

    if (modalEl && okBtn) {
      log('Using #codeConfirmModal fallback');
      if (textEl) textEl.textContent = `Confirm: ${summarize(state)}`;

      // clean old listeners (clone trick)
      [okBtn, cancel, closeX].forEach(b=>{
        if (!b || !b.parentNode) return;
        const c = b.cloneNode(true);
        b.parentNode.replaceChild(c, b);
      });

      const ok = document.getElementById('codeConfirmConfirmBtn');
      const cc = document.getElementById('codeConfirmCancelBtn');
      const xx = document.getElementById('codeConfirmCloseX');

      function show(){ modalEl.classList.remove('hidden'); modalEl.setAttribute('aria-hidden','false'); }
      function hide(){ modalEl.classList.add('hidden'); modalEl.setAttribute('aria-hidden','true'); }

      ok?.addEventListener('click', async () => { hide(); await onConfirm?.(state); });
      const close = () => hide();
      cc?.addEventListener('click', close);
      xx?.addEventListener('click', close);
      document.addEventListener('keydown', function esc(e){ if(e.key==='Escape'){ hide(); document.removeEventListener('keydown', esc);} }, { once: true });

      show();
      return;
    }

    // Last-resort: inline micro-modal (no CSS dependencies)
    log('Using inline micro-modal fallback');
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:9999;';
    wrap.innerHTML = `
      <div style="background:#fff;max-width:560px;width:92%;padding:16px;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.2);font-family:system-ui,Segoe UI,Arial,sans-serif">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <h3 style="margin:0;font-size:18px">Please Confirm</h3>
          <button id="_cf_x" aria-label="Close" style="font-size:18px;line-height:1;background:transparent;border:none;cursor:pointer">×</button>
        </div>
        <div style="margin:8px 0 16px">${summarize(state) || 'No details provided.'}</div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button id="_cf_cancel">Cancel</button>
          <button id="_cf_ok" style="padding:6px 12px">Confirm</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const close = () => { try{document.body.removeChild(wrap);}catch{} };
    wrap.querySelector('#_cf_ok')   .addEventListener('click', async () => { close(); await onConfirm?.(state); });
    wrap.querySelector('#_cf_cancel').addEventListener('click', close);
    wrap.querySelector('#_cf_x')    .addEventListener('click', close);
  }

  // --- recent (adapter + fallback) -----------------------------------------
  function normalizeForRecent(row = {}) {
    return {
      name:      norm(row.name),
      set:       norm(row.set ?? row.setCode ?? row.set_name),
      code:      norm(row.code ?? row.printingCode ?? row.set_code),
      rarity:    norm(row.rarity ?? row.rarity_name),
      condition: norm(row.condition),
      qty:       toInt(row.qty ?? 1)
    };
  }
  function kOf(r){ return [r.name, r.set, r.rarity, r.condition].map(s => s.toLowerCase()).join('|'); }

  function recentPushFallback(row) {
    const r = normalizeForRecent(row);
    const tbody = document.querySelector('#grid tbody');
    if (!tbody) { warn('Recent tbody #grid tbody not found'); return; }

    const k = kOf(r);
    const existing = Array.from(tbody.querySelectorAll('tr')).find(tr => tr.dataset.key === k);

    if (existing) {
      const qtyCell  = existing.querySelector('[data-col="qty"]')  || existing.children[5];
      const sentCell = existing.querySelector('[data-col="sent"]') || existing.children[6];
      const cur = toInt(qtyCell?.textContent || '0', 0);
      if (qtyCell) qtyCell.textContent = String(cur + r.qty);
      if (sentCell) sentCell.textContent = '✓';
      return;
    }

    const tr = document.createElement('tr');
    tr.dataset.key = k;
    tr.innerHTML = `
      <td>${r.name}</td>
      <td>${r.set}</td>
      <td>${r.code}</td>
      <td>${r.rarity}</td>
      <td>${r.condition}</td>
      <td data-col="qty">${r.qty}</td>
      <td data-col="sent">✓</td>`;
    tbody.prepend(tr);
  }

  function pushRecent(row) {
    if (window.confirmRecent?.push) {
      try { window.confirmRecent.push(row); return; } catch(e){ err('confirmRecent.push error', e); }
    }
    recentPushFallback(row);
  }

  // --- main click handler ---------------------------------------------------
  async function onClick(e) {
    e.preventDefault();
    log('Post to Sheet clicked');

    const payload = currentPayload();

    ensureModalAndOpen({
      state: payload,
      onConfirm: async (confirmed) => {
        if (typeof window.sendToSheet !== 'function') {
          err('sendToSheet missing on window'); 
          return;
        }
        try {
          log('Confirmed; sending to sheet…', confirmed);
          await window.sendToSheet(confirmed);
          pushRecent(confirmed);
          
          if (typeof window.resetSelectionForm === "function") window.resetSelectionForm();

          log('Sent to sheet and recent updated.');
        } catch (e) {
          err('sendToSheet failed', e);
        }
      }
    });
  }

  // --- bind ----------------------------------------------------------------
  function bindOnce() {
    const btn = findPostBtn();
    if (!btn) return false;
    try { btn.disabled = false; } catch {}
    btn.addEventListener('click', onClick, { once: false });
    btn.dataset.confirmBound = '1';
    log('Bound click to:', btn);
    return true;
  }

  function init() {
    if (bindOnce()) return;
    let attempts = 0;
    const t = setInterval(() => {
      attempts++;
      if (bindOnce() || attempts >= 12) clearInterval(t);
      if (attempts >= 12) warn('Could not find Post to Sheet button after retries.');
    }, 150);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window._confirmBind = init; // debug hook
  log('controller loaded');
})();
