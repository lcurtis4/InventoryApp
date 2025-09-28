(function () {
  const cfg = window.APP_CONFIG || {};
  const BASE_URL = String(
    cfg.SHEETS_SCRIPT_URL || cfg.SCRIPT_URL || ""
  ).trim();
  const SECRET = String(cfg.SECRET || "0104200206121997").trim();

  if (!BASE_URL) {
    console.warn("[sheetsClient] Missing APP_CONFIG.SHEETS_SCRIPT_URL");
  }

  async function sendToSheet(row) {
    if (!BASE_URL) throw new Error("Sheets script URL not configured");

    // Build query params
    const url = new URL(BASE_URL);
    url.searchParams.set("key", SECRET);
    for (const [k, v] of Object.entries(row)) {
      url.searchParams.set(k, v);
    }

    // Log the payload for debugging
    console.log("[sheetsClient] Sending row (GET):", Object.fromEntries(url.searchParams));

    // ✅ Use GET to avoid CORS preflight
    const res = await fetch(url.toString(), { method: "GET" });

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      throw new Error(
        `[sheetsClient] Non-JSON response (${res.status}): ${text.slice(0, 300)}`
      );
    }
    if (data.status !== "OK") {
      throw new Error(data.message || "Sheet insert failed");
    }
    return data;
  }

  window.Sheet = {
    sendToSheet,
    sendRow: sendToSheet
  };
})();
