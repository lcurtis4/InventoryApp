// js/integrations/sheetsClient.js — v10
// v10: surface duplicate-merge response fields ({merged, newQty, addedQty}) so
// the UI can tell the user "merged into row N" vs "added row N".
// v9.3: Verifiable POST + startup health-ping.
//   Prior versions used mode:"no-cors" which makes the response opaque,
//   so a 404/500/500 from Apps Script was silently swallowed and the UI
//   showed a fake "Added to Sheet" success.
//
//   New behavior:
//     1. On module load, fire a GET <url>?ping=1 in the background. The new
//        Code.gs (v9.3) returns {ok:true, version:"v9.3"}. If the ping fails
//        OR the response is "Script function not found: doPost"-style, log a
//        clear warning so the user knows the deployment is bad.
//     2. sendToSheet() now POSTs as text/plain (a "simple request" — no CORS
//        preflight required), reads the JSON response body, and RESOLVES with
//        {ok:true, row:N} or {ok:false, error:"..."} so callers can detect
//        real success vs silent failure.
//     3. confirm.js will check the result before showing the success modal.

(function () {
  const cfg = window.APP_CONFIG || {};

  const RAW_URL = String(
    cfg.SHEETS_SCRIPT_URL || cfg.SHEETS_DEPLOYMENT || cfg.SCRIPT_URL || ""
  ).trim();
  const SECRET = String(cfg.SECRET || "").trim();

  function ensureExecUrl(u) {
    if (!u) return "";
    return /\/exec(\?|$)/.test(u) ? u : u.replace(/\/+$/, "") + "/exec";
  }
  const URL = ensureExecUrl(RAW_URL);

  // CONSOLE-OFF v12 console.log("[sheetsClient] module loaded — v10 (merge-aware POST + ping)");
  // CONSOLE-OFF v12 if (!URL)    console.warn("[sheetsClient] APP_CONFIG.SHEETS_SCRIPT_URL is missing");
  // CONSOLE-OFF v12 if (!SECRET) console.warn("[sheetsClient] APP_CONFIG.SECRET is missing");

  // ── Health ping (one-shot at module load) ────────────────────────────────
  // The new Code.gs (v9.3) handles ?ping=1 and returns JSON. Old/broken
  // deployments return either 404 or an Apps Script HTML error page.
  let _pingResult = { ok: false, pending: true, error: "not yet pinged" };

  async function _runPing() {
    if (!URL) {
      _pingResult = { ok: false, pending: false, error: "no URL configured" };
      // CONSOLE-OFF v12 console.warn("[sheetsClient] PING SKIPPED — no URL configured");
      return;
    }
    try {
      const res = await fetch(URL + "?ping=1", { method: "GET", redirect: "follow" });
      const text = await res.text();
      if (!res.ok) {
        _pingResult = { ok: false, pending: false, error: "HTTP " + res.status, body: text.slice(0, 200) };
        // CONSOLE-OFF v12 console.warn("[sheetsClient] ✗ PING FAIL: HTTP", res.status, "— is the deployment URL correct?");
        return;
      }
      // Try to parse JSON; tolerate Apps Script HTML error pages
      let parsed = null;
      try { parsed = JSON.parse(text); } catch {}
      if (parsed && parsed.ok) {
        _pingResult = { ok: true, pending: false, version: parsed.version || "?", time: parsed.time };
        // CONSOLE-OFF v12 console.log("[sheetsClient] ✓ PING OK — backend", parsed.version || "(unknown)", "@", parsed.time);
      } else {
        _pingResult = { ok: false, pending: false, error: "non-JSON or ok:false response", body: text.slice(0, 200) };
        // CONSOLE-OFF v12 console.warn("[sheetsClient] ✗ PING returned unexpected body:", text.slice(0, 200));
      }
    } catch (err) {
      _pingResult = { ok: false, pending: false, error: String(err && err.message || err) };
      // CONSOLE-OFF v12 console.warn("[sheetsClient] ✗ PING threw:", err);
    }
  }
  _runPing();

  function getPingResult() { return _pingResult; }

  // ── Core send ────────────────────────────────────────────────────────────
  window.Sheet = (function () {
    function normalizePrice(p) {
      if (p === undefined || p === null || p === "") return "";
      const n = Number(p);
      return Number.isFinite(n) ? n : "";
    }

    /**
     * Append a row to the Inventory sheet via the Apps Script Web App.
     * Resolves with:
     *   { ok: true,  row: <row#>, raw: <response body> }   on success
     *   { ok: false, error: "<message>", status?: <http>, body?: "..." }  on failure
     * NEVER throws — callers can rely on the return value.
     */
    async function sendToSheet(row) {
      if (!URL)    return { ok: false, error: "no URL configured" };
      if (!SECRET) return { ok: false, error: "no SECRET configured" };

      const postUrl = `${URL}?key=${encodeURIComponent(SECRET)}`;

      const payload = {
        ...row,
        price: normalizePrice(row.price ?? row.tcgplayer_price)
      };

      try {
        // text/plain keeps this a "simple request" — no CORS preflight, and
        // Apps Script Web Apps DO permit cross-origin reads of the response
        // body for simple requests on the *.googleusercontent.com redirect.
        const res = await fetch(postUrl, {
          method: "POST",
          mode: "cors",
          redirect: "follow",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify(payload)
        });

        const text = await res.text();
        if (!res.ok) {
          console.error("[sheetsClient] POST HTTP", res.status, "— body:", text.slice(0, 300));
          return { ok: false, error: "HTTP " + res.status, status: res.status, body: text.slice(0, 300) };
        }

        let parsed = null;
        try { parsed = JSON.parse(text); } catch {}
        if (parsed && parsed.ok === true) {
          if (parsed.merged) {
            // CONSOLE-OFF v12 console.log("[sheetsClient] ✓ POST merged — row", parsed.row, "newQty", parsed.newQty);
          } else {
            // CONSOLE-OFF v12 console.log("[sheetsClient] ✓ POST appended — row", parsed.row);
          }
          return {
            ok: true,
            row: parsed.row || null,
            merged: parsed.merged === true,
            newQty: parsed.newQty ?? null,
            addedQty: parsed.addedQty ?? null,
            raw: parsed
          };
        }

        // Apps Script error pages come back as HTML even on HTTP 200.
        // If we couldn't parse JSON OR ok:false, treat as failure.
        const errMsg = (parsed && parsed.error) || "non-JSON or ok:false response";
        console.error("[sheetsClient] ✗ POST returned unexpected body:", text.slice(0, 300));
        return { ok: false, error: errMsg, body: text.slice(0, 300) };
      } catch (err) {
        console.error("[sheetsClient] sendToSheet threw:", err);
        return { ok: false, error: String(err && err.message || err) };
      }
    }

    return { sendToSheet, getPingResult };
  })();
})();
