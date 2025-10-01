// js/ui/confirm.js (BRANCH) — vCONF-5
// Confirm -> build row -> send via window.Sheet.sendToSheet(row)

(function () {
  // ---- Element helpers ----
  const $ = (sel) => document.querySelector(sel);
  const ocrNameEl = $("#ocrName");
  const manualNameEl = $("#manualName");
  const setSel = $("#setSelect");
  const raritySel = $("#raritySelect");
  const qtyEl = $("#qty");
  const conditionSel = $("#conditionSelect");
  const confirmBtn = $("#confirmBtn");
  const confirmStatus = $("#confirmPickStatus") || $("#confirmStatus");

  // Access shared UI state (set by ui/lookup.js)
  const UI = (window.UI = window.UI || {});
  const State = (UI.State = UI.State || {});

  // Code Confirm modal (branch)
  const codeModal = $("#codeConfirmModal");
  const codeConfirmText = $("#codeConfirmText");
  const codeConfirmCloseX = $("#codeConfirmCloseX");
  const codeConfirmCancelBtn = $("#codeConfirmCancelBtn");
  const codeConfirmConfirmBtn = $("#codeConfirmConfirmBtn");

  // Success modal
  const successModal = $("#successModal");
  const successModalBody = $("#successModalBody");

  // Recent grid
  const gridBody = document.querySelector("#grid tbody");

  // --- SAFE select helpers ---
  function getSelectedOption(selectEl) {
    if (!selectEl || !selectEl.options) return null;
    const idx = typeof selectEl.selectedIndex === "number" ? selectEl.selectedIndex : -1;
    if (idx < 0 || idx >= selectEl.options.length) return null;
    return selectEl.options[idx] || null;
  }
  function getSelectedText(selectEl) {
    const opt = getSelectedOption(selectEl);
    return opt?.textContent?.trim?.() ?? "";
  }
  function getSelectedValue(selectEl) {
    const opt = getSelectedOption(selectEl);
    return (opt?.value ?? "").toString().trim();
  }

  function extractCodeFromOption(optText) {
    // Fallback: "Legend of Blue Eyes (LOB-001)" -> "LOB-001"
    const m = optText && optText.match(/\(([A-Za-z0-9\-]+)\)\s*$/);
    return m ? m[1] : "";
  }

  function showStatus(msg, kind = "info") {
    if (!confirmStatus) return;
    confirmStatus.textContent = msg;
    confirmStatus.className = "status " + (kind === "error" ? "error" : kind === "ok" ? "ok" : "");
  }

  function openSuccessModal(messageHtml) {
    if (!successModal) return;
    successModalBody.innerHTML = messageHtml || "Added.";
    successModal.classList.remove("hidden");
    successModal.setAttribute("aria-hidden", "false");
    successModal.querySelector(".modal__close")?.addEventListener("click", () => closeSuccessModal());
    successModal.querySelector(".modal__ok")?.addEventListener("click", () => closeSuccessModal());
  }
  function closeSuccessModal() {
    successModal?.classList.add("hidden");
    successModal?.setAttribute("aria-hidden", "true");
  }
  function openCodeConfirmModal(codePreview) {
    if (!codeModal) return;
    codeConfirmText.textContent = "Confirm Card Code: " + (codePreview || "(none)");
    codeModal.classList.remove("hidden");
    codeModal.setAttribute("aria-hidden", "false");
  }
  function closeCodeConfirmModal() {
    codeModal?.classList.add("hidden");
    codeModal?.setAttribute("aria-hidden", "true");
  }

  function buildRowFromUI() {
    // Prefer manual name; fall back to OCR
    const name = (manualNameEl?.value || "").trim() || (ocrNameEl?.value || "").trim();

    // Pull selection from UI.State populated by ui/lookup.js
    const setName  = State?.selectedSetName || getSelectedValue(setSel) || getSelectedText(setSel);
    const rarity   = State?.selectedRarity  || getSelectedValue(raritySel) || getSelectedText(raritySel);
    const printing = State?.selectedPrinting || null;

    // ✅ Primary source for code (correct): from selected printing
    let code = printing?.set_code || "";
    // Fallback (older behavior): try to scrape from set option label
    if (!code) code = extractCodeFromOption(getSelectedText(setSel));

    const qty       = parseInt(qtyEl?.value || "1", 10) || 1;
    const condition = getSelectedValue(conditionSel) || getSelectedText(conditionSel);

    // System name from config (preferred), else State, else "desktop"
    const system =
      (window.APP_CONFIG?.DEVICE_NAME ?? window.APP_CONFIG?.deviceName) ||
      window.UI?.State?.deviceName ||
      "desktop";
    State.source = system; // publish for anyone else

    return {
      timestamp: new Date().toISOString(),
      name,
      set: setName || "",
      code: code || "",
      rarity: rarity || "",
      condition: condition || "",
      qty,
      source: "Logan's Desktop",
    };
  }

  function validateRow(row) {
    if (!row.name) return "Please choose a card name (Manual or Scanned).";
    if (!row.set) return "Please choose a Set.";
    if (!row.rarity) return "Please choose a Rarity.";
    if (!row.condition) return "Please choose a Condition.";
    if (!row.qty || row.qty < 1) return "Quantity must be at least 1.";
    // Optional: enforce code only if your sheet requires it
    // if (!row.code) return "Please pick a printing (code).";
    return null;
  }

  function appendToRecentGrid(row) {
    if (!gridBody) return;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.name}</td>
      <td>${row.set}</td>
      <td>${row.code || ""}</td>
      <td>${row.rarity}</td>
      <td>${row.condition}</td>
      <td>${row.qty}</td>
      <td>yes</td>
    `;
    gridBody.prepend(tr);
  }

  function resetForm() {
    if (manualNameEl) manualNameEl.value = "";
    if (setSel) setSel.selectedIndex = 0;
    if (raritySel) raritySel.selectedIndex = 0;
    if (conditionSel) conditionSel.selectedIndex = 0;
    if (qtyEl) qtyEl.value = "";
    showStatus("Ready for next card.", "ok");
  }

  async function postCurrentSelection() {
    try {
      showStatus("Posting…");
      const row = buildRowFromUI();
      const err = validateRow(row);
      if (err) { showStatus(err, "error"); console.warn("[confirm] validation failed:", err, row); return; }

      if (!window.Sheet || typeof window.Sheet.sendToSheet !== "function") {
        console.error("[confirm] Sheet.sendToSheet() is not available.");
        showStatus("Cannot post: Sheets client not ready.", "error");
        return;
      }

      console.log("[confirm] sending row:", row);
      await window.Sheet.sendToSheet(row);

      appendToRecentGrid(row);
      openSuccessModal(
        `<div><strong>${row.name}</strong> (${row.set}${row.code ? " • " + row.code : ""})</div>
         <div>Rarity: ${row.rarity} • Condition: ${row.condition} • Qty: ${row.qty}</div>`
      );
      resetForm();
    } catch (e) {
      console.error("[confirm] post failed:", e);
      showStatus("Failed to post. See console.", "error");
    }
  }

  // --- Wire up: Confirm modal buttons ---
  codeConfirmConfirmBtn?.addEventListener("click", async () => {
    closeCodeConfirmModal();
    await postCurrentSelection();
  });
  codeConfirmCancelBtn?.addEventListener("click", () => {
    closeCodeConfirmModal();
    showStatus("Canceled.", "info");
  });
  codeConfirmCloseX?.addEventListener("click", () => {
    closeCodeConfirmModal();
  });

  // --- Primary button (opens modal, then posts) ---
  confirmBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    // Preview using State first (more accurate), fallback to label scrape
    const previewCode = (State?.selectedPrinting?.set_code) || extractCodeFromOption(getSelectedText(setSel));
    if (codeModal) {
      openCodeConfirmModal(previewCode);
    } else {
      postCurrentSelection();
    }
  });

  console.log("[confirm] branch confirm.js initialized :: vCONF-5");
})();
