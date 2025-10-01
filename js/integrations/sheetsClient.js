// js/integrations/sheetsClient.js
(function () {
  const cfg = window.APP_CONFIG || {};

  // Accept several config keys you've used in past versions
  const BASE_RAW =
    (cfg.SHEETS_DEPLOYMENT || cfg.SHEETS_SCRIPT_URL || cfg.SCRIPT_URL || "").trim();

  const SECRET = String(cfg.SECRET || "0104200206121997").trim();

  function ensureExecUrl(u) {
    // Allow full exec URL or the base deployment URL
    // Examples supported:
    //  - https://script.google.com/macros/s/AKfycbx.../exec
    //  - https://script.google.com/macros/s/AKfycbx...  (we'll append /exec)
    if (!u) return "";
    const url = String(u);
    return /\/exec(\?|$)/.test(url) ? url : url.replace(/\/+$/, "") + "/exec";
  }

  const BASE_URL = ensureExecUrl(BASE_RAW);

  function assertConfig() {
    if (!BASE_URL) {
      throw new Error(
        "[sheetsClient] Missing APP_CONFIG.SHEETS_DEPLOYMENT (or SHEETS_SCRIPT_URL/SCRIPT_URL)."
      );
    }
    if (!SECRET) {
      console.warn("[sheetsClient] Missing APP_CONFIG.SECRET; using default.");
    }
  }

  function buildGetUrl(base, payload) {
    const url = new URL(base);
    url.searchParams.set("key", SECRET);
    Object.entries(payload || {}).forEach(([k, v]) => {
      url.searchParams.set(k, v == null ? "" : String(v));
    });
    return url.toString();
  }

  /**
   * Send a row to the Google Apps Script endpoint.
   * FIRE-AND-FORGET with `mode:'no-cors'` so the browser never rejects on CORS.
   * We don't read/parse the response at all.
   */
  async function sendToSheet(row) {
    assertConfig();

    const payload = row || {};
    const postUrl = `${BASE_URL}?key=${encodeURIComponent(SECRET)}`;

    // Try SIMPLE POST first — with no-cors to avoid CORS rejections.
    try {
      console.log("[sheetsClient] POSTing payload (no-cors):", payload);
      await fetch(postUrl, {
        method: "POST",
        mode: "no-cors",                     // <— key change
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify(payload),
      });
      // We can't read status/body in no-cors mode; assume success.
      return { status: "OK", transport: "POST" };
    } catch (err) {
      console.warn("[sheetsClient] POST threw, falling back to GET:", err);
    }

    // Fallback: GET, also no-cors to prevent rejection.
    try {
      const getUrl = buildGetUrl(BASE_URL, payload);
      if (getUrl.length > 1800) {
        console.warn(
          "[sheetsClient] GET URL is long (",
          getUrl.length,
          "chars). Consider trimming payload."
        );
      }
      console.log("[sheetsClient] Sending row (GET no-cors):", payload);
      await fetch(getUrl, { method: "GET", mode: "no-cors" }); // <— no-cors
      return { status: "OK", transport: "GET" };
    } catch (err2) {
      console.error("[sheetsClient] Both POST and GET failed:", err2);
      return { status: "FAILED", error: err2?.message || String(err2) };
    }
  }

  // Public API
  window.Sheet = {
    sendToSheet,
    sendRow: sendToSheet, // keep backward compatibility
  };
})();
