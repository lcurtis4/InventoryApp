// js/integrations/sheetsClient.js
(function () {
  'use strict';

  const cfg = window.APP_CONFIG || {};
  const RAW_URL =
    String(cfg.SHEETS_SCRIPT_URL || cfg.SHEETS_DEPLOYMENT || cfg.SCRIPT_URL || '').trim();
  const SECRET = String(cfg.SECRET || '0104200206121997').trim();

  function toExecUrl(u) {
    if (!u) return '';
    return /\/exec(\?|$)/.test(u) ? u : u.replace(/\/+$/, '') + '/exec';
  }

  const URL = toExecUrl(RAW_URL);

  function assertCfg() {
    if (!URL)   throw new Error('[sheetsClient] Missing Apps Script URL');
    if (!SECRET) throw new Error('[sheetsClient] Missing SECRET');
  }

  async function sendToSheet(row) {
    assertCfg();
    const postUrl = `${URL}?key=${encodeURIComponent(SECRET)}`;
    try {
      await fetch(postUrl, {
        method: 'POST',
        mode: 'no-cors',
        body: JSON.stringify(row) // Apps Script reads e.postData.contents
      });
      // Opaque by design; rely on Sheet as the source of truth.
    } catch (err) {
      console.error('[sheetsClient] sendToSheet failed:', err);
    }
  }

  // Export in BOTH places, so the controller can use window.sendToSheet
  // and any legacy code can use window.Sheet.sendToSheet.
  window.sendToSheet = sendToSheet;
  window.Sheet = window.Sheet || {};
  window.Sheet.sendToSheet = sendToSheet;

  // Helpful debug ping so you can verify load order in Console
  try {
    console.debug('[sheetsClient] ready', { hasURL: !!URL, hasSECRET: !!SECRET });
  } catch {}
})();
