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
      // stringify everything to be safe for URL params
      url.searchParams.set(k, v == null ? "" : String(v));
    });
    return url.toString();
  }

  async function parseJsonResponse(res) {
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(
        `[sheetsClient] Non-JSON response (HTTP ${res.status}): ${text.slice(0, 300)}`
      );
    }
    if (!res.ok) {
      throw new Error(
        `[sheetsClient] HTTP ${res.status} — ${data.message || "Request failed"}`
      );
    }
    if (data.status && data.status !== "OK") {
      throw new Error(`[sheetsClient] ${data.message || "Sheet insert failed"}`);
    }
    return data;
  }

  /**
   * Send a row to the Google Apps Script endpoint.
   * Prefers a "simple" POST (Content-Type: text/plain) to AVOID preflight.
   * Falls back to GET (querystring) if POST fails for any reason.
   */
  async function sendToSheet(row) {
    assertConfig();

    const payload = row || {};
    const postUrl = `${BASE_URL}?key=${encodeURIComponent(SECRET)}`;

    // Try SIMPLE POST first — no custom headers that trigger preflight
    try {
      console.log("[sheetsClient] POSTing (simple) payload:", payload);
      const res = await fetch(postUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain" }, // simple request, no preflight
        body: JSON.stringify(payload),
      });
      return await parseJsonResponse(res);
    } catch (err) {
      console.warn("[sheetsClient] POST failed, falling back to GET:", err);
    }

    // Fallback: GET (also a simple request)
    const getUrl = buildGetUrl(BASE_URL, payload);
    // Heads up: extremely large payloads can exceed URL length limits.
    if (getUrl.length > 1800) {
      console.warn(
        "[sheetsClient] GET URL is long (",
        getUrl.length,
        "chars ). Consider trimming payload."
      );
    }
    console.log("[sheetsClient] Sending row (GET):", payload);
    const res = await fetch(getUrl, { method: "GET" });
    return await parseJsonResponse(res);
  }

  // Public API
  window.Sheet = {
    sendToSheet,
    sendRow: sendToSheet, // keep backward compatibility
  };
})();
