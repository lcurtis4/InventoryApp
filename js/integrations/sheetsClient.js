// js/integrations/sheetsClient.js — vSC-6
// POST row -> Apps Script doPost(e), read JSON response for debugging

(function () {
  const cfg = window.APP_CONFIG || {};

  // Accept multiple config keys you've used before
  const RAW_URL = String(
    cfg.SHEETS_SCRIPT_URL || cfg.SHEETS_DEPLOYMENT || cfg.SCRIPT_URL || ""
  ).trim();
  const SECRET = String(cfg.SECRET || "0104200206121997").trim();

  function ensureExecUrl(u) {
    if (!u) return "";
    return /\/exec(\?|$)/.test(u) ? u : u.replace(/\/+$/, "") + "/exec";
  }
  const URL = ensureExecUrl(RAW_URL);

  function assertConfig() {
    if (!URL) throw new Error("APP_CONFIG.SHEETS_SCRIPT_URL is missing");
    if (!SECRET) throw new Error("APP_CONFIG.SECRET is missing");
  }

  window.Sheet = (function () {
  const cfg = window.APP_CONFIG || {};
  const URL = (cfg.SHEETS_SCRIPT_URL || cfg.SHEETS_DEPLOYMENT || cfg.SCRIPT_URL || "").replace(/\/+$/, "") + "/exec";
  const KEY = String(cfg.SECRET || "");

  function assertCfg() {
    if (!URL) throw new Error("APP_CONFIG.SHEETS_SCRIPT_URL is missing");
    if (!KEY) throw new Error("APP_CONFIG.SECRET is missing");
  }

  async function sendToSheet(row) {
    assertCfg();
    const postUrl = `${URL}?key=${encodeURIComponent(KEY)}`;

    // IMPORTANT: no headers -> simple request -> no preflight
    try {
      await fetch(postUrl, {
        method: "POST",
        mode: "no-cors",
        body: JSON.stringify(row) // text/plain by default; Apps Script parses e.postData.contents
      });
      // Response will be opaque by design; rely on the Sheet as source of truth
    } catch (err) {
      console.error("[sheetsClient] sendToSheet failed:", err);
    }
  }

  return { sendToSheet };
})();


  window.Sheet = { sendToSheet };
})();
