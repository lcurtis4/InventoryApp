// js/ui/confirm.js
// Build a complete row from State/DOM and send it to the Google Sheet.
// Expects backend response: { status: 'OK', ... } (from Apps Script),
// or the wrapper from sheetsClient: { ok:true, status:'OK', ... }

(function () {
  // ---------- Helpers ----------
  const $ = (id) => document.getElementById(id);

  function normText(s) {
    return String(s || "")
      .replace(/[\u2018\u2019\u201C\u201D]/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  }

  function toQty(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
  }

  function ensureKey(url) {
    try {
      const u = new URL(url, window.location.origin);
      if (!u.searchParams.get("key")) {
        const secret =
          (window.APP_CONFIG && window.APP_CONFIG.SECRET) ||
          "0104200206121997"; // fallback to your known SECRET
        u.searchParams.set("key", secret);
      }
      return u.toString();
    } catch {
      return url;
    }
  }

  function getSelectedOption(selectEl) {
    if (!selectEl) return null;
    const i = selectEl.selectedIndex;
    if (i < 0) return null;
    return selectEl.options[i] || null;
  }

  function inferCode() {
    const sp = window.UI?.State?.selectedPrinting;
    if (sp?.set_code) return normText(sp.set_code);

    if (window.State?.code) return normText(window.State.code);

    const codeEl = $("code");
    if (codeEl?.value) return normText(codeEl.value);

    const opt = getSelectedOption($("setSelect"));
    if (!opt) return "";

    if (opt?.dataset?.code) return normText(opt.dataset.code);

    const looksLikeCardCode = /^[A-Z0-9]{2,6}-[A-Z]{1,3}\d{2,4}$/i.test(opt.value || "");
    if (looksLikeCardCode) return normText(opt.value);

    return "";
  }

  function buildRowFromUI() {
    const manual = normText($("manualName")?.value);
    const scanned = normText($("ocrName")?.value);
    const stateName = normText(window.State?.name || "");
    const name = manual || scanned || stateName;

    const set = normText($("setSelect")?.value || window.State?.set || "");
    const rarity = normText($("raritySelect")?.value || window.State?.rarity || "");
    const condition = normText($("conditionSelect")?.value || window.State?.condition || "");
    const qty = toQty($("qty")?.value ?? window.State?.qty ?? 1);

    let code = inferCode();
    if (code && set && code.toLowerCase() === set.toLowerCase()) {
      code = "";
    }

    return { name, set, code, rarity, condition, qty, source: "Desktop" };
  }

  async function sendRow(row) {
    if (window.Sheet && typeof window.Sheet.sendToSheet === "function") {
      return window.Sheet.sendToSheet(row);
    }

    const url = ensureKey((window.APP_CONFIG && window.APP_CONFIG.SCRIPT_URL) || "");
    if (!url) throw new Error("Missing SCRIPT_URL for sheet POST.");

    const form = new URLSearchParams();
    Object.entries({
      name: row.name,
      set: row.set,
      code: row.code,
      rarity: row.rarity,
      condition: row.condition,
      qty: String(row.qty),
      source: row.source || "Desktop"
    }).forEach(([k, v]) => form.set(k, v ?? ""));

    const res = await fetch(url, { method: "POST", body: form });
    const raw = await res.text();
    try {
      const json = JSON.parse(raw);
      return json;
    } catch {
      if (/^ok$/i.test(raw.trim()) || /script:\s*ok/i.test(raw)) {
        return { status: "OK", ok: true, raw };
      }
      throw new Error(`Bad response (${res.status})`);
    }
  }

  function showToast(message, variant) {
    const t = $("statusToast") || $("status");
    if (!t) return;
    t.textContent = message;
    t.dataset.variant = variant || "info";
  }

  function openPopup(row, result) {
    if (window.UI?.modal?.open) {
      const html =
        `<p><strong>${row.name || "(no name)"} </strong></p>` +
        `<p>${row.set || "(set?)"} • ${row.rarity || "(rarity?)"} • ${row.condition || "NM"} × ${row.qty}` +
        `${row.code ? ` • ${row.code}` : ""}</p>` +
        (result?.row ? `<p>Row: ${result.row} (${result.mode || ""})</p>` : "");
      window.UI.modal.open(html);
      return;
    }
    alert(`Added to sheet:\n${row.name}\n${row.set} • ${row.rarity} • ${row.condition} × ${row.qty}${row.code ? ` • ${row.code}` : ""}`);
  }

  async function handleConfirm(ev) {
    ev?.preventDefault?.();
    const btn = ev?.currentTarget || $("confirmBtn");

    const row = buildRowFromUI();
    console.log("[confirm] sending row", row);

    try {
      if (btn) btn.disabled = true;

      const result = await sendRow(row);
      console.log("[confirm] response", result);

      const status = String(result?.status || (result?.ok ? "OK" : "")).toUpperCase();
      if (status !== "OK") {
        const msg = result?.message || "Server did not return OK";
        throw new Error(msg);
      }

      showToast("Added to sheet!", "success");
      openPopup(row, result);

    } catch (err) {
      console.error("[confirm] failed:", err);
      showToast(String(err?.message || err || "Failed to add"), "error");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  const btn = $("confirmBtn");
  if (btn) {
    btn.removeEventListener("click", handleConfirm);
    btn.addEventListener("click", handleConfirm);
  }

  window.Confirm = { handleConfirm };
})();
