// js/ui/confirm/utils.js
// -----------------------------------------------------------------------------
// Utilities (escapeHtml, toInt, key building)
// -----------------------------------------------------------------------------
(function () {
  'use strict';

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function toInt(n, fallback = 1) {
    const x = Number(n);
    return Number.isFinite(x) && x > 0 ? x : fallback;
  }

  // Build a stable key matching Sheet's uniqueness rule.
  function buildRecentKey(row) {
    return [
      row?.name,
      row?.set,
      row?.code,
      row?.rarity,
      row?.condition
    ].map(v => String(v ?? '').trim().toLowerCase()).join('|');
  }

  window.ConfirmUI = window.ConfirmUI || {};
  window.ConfirmUI.utils = { escapeHtml, toInt, buildRecentKey };
})();