// js/ui/confirm_modularized/js/recent.js
// Updates the "Recent Items" table after a successful post.
// - Normalizes incoming payload keys (setCode -> set, printingCode -> code, etc.).
// - Dedupes by name+set+rarity+condition and increments qty.
// - Uses ConfirmUI.recent if available; otherwise updates #grid tbody directly.

(function () {
  'use strict';

  function toInt(n, d = 1) {
    const v = parseInt(n, 10);
    return Number.isFinite(v) && v > 0 ? v : d;
  }

  function normStr(v) {
    return String(v ?? '').trim();
  }

  // Normalize various payload shapes into a consistent row for Recent.
  function normalizeRow(row = {}) {
    const name      = normStr(row.name);
    const set       = normStr(row.set ?? row.setCode ?? row.set_name);
    const code      = normStr(row.code ?? row.printingCode ?? row.set_code);
    const rarity    = normStr(row.rarity ?? row.rarity_name);
    const condition = normStr(row.condition);
    const qty       = toInt(row.qty ?? 1);

    return { name, set, code, rarity, condition, qty };
  }

  function keyOf(r) {
    return [r.name, r.set, r.rarity, r.condition]
      .map(s => s.toLowerCase())
      .join('|');
  }

  // Direct DOM updater (fallback if ConfirmUI.recent is not available)
  function pushToDom(row) {
    const tbody = document.querySelector('#grid tbody');
    if (!tbody) return;

    const k = keyOf(row);
    const existing = Array.from(tbody.querySelectorAll('tr')).find(tr => tr.dataset.key === k);

    if (existing) {
      const qtyCell  = existing.querySelector('[data-col="qty"]')  || existing.children[5];
      const sentCell = existing.querySelector('[data-col="sent"]') || existing.children[6];
      qtyCell.textContent = String(toInt(qtyCell.textContent) + row.qty);
      if (sentCell) sentCell.textContent = '✓';
      return;
    }

    const tr = document.createElement('tr');
    tr.dataset.key = k;
    tr.innerHTML = `
      <td>${row.name}</td>
      <td>${row.set}</td>
      <td>${row.code}</td>
      <td>${row.rarity}</td>
      <td>${row.condition}</td>
      <td data-col="qty">${row.qty}</td>
      <td data-col="sent">✓</td>
    `;
    tbody.prepend(tr);
  }

  function push(row) {
    const r = normalizeRow(row);

    // Prefer your existing ConfirmUI flow if present
    if (window.ConfirmUI?.recent?.addRowToRecentTable) {
      window.ConfirmUI.recent.addRowToRecentTable({
        name: r.name,
        set: r.set,
        code: r.code,
        rarity: r.rarity,
        condition: r.condition,
        qty: r.qty
      });
      return;
    }

    // Fallback: manipulate the table directly
    pushToDom(r);
  }

  // Public adapter used by the controller
  window.confirmRecent = window.confirmRecent || {};
  window.confirmRecent.push = push;
})();
