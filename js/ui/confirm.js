// js/ui/confirm.js  (BRANCH)
// Wires the Confirm flow to the same downstream transport main uses: window.Sheet.sendToSheet(row)

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

  // Code Confirm modal (branch)
  const codeModal = $("#codeConfirmModal");
  const codeConfirmText = $("#codeConfirmText");
  const codeConfirmCloseX = $("#codeConfirmCloseX");
  const codeConfirmCancelBtn = $("#codeConfirmCancelBtn");
  const codeConfirmConfirmBtn = $("#codeConfirmConfirmBtn");

  // Success modal (already in index.html)
  const successModal = $("#successModal");
  const successModalBody = $("#successModalBody");

  // Recent grid
  const gridBody = document.querySelector("#grid tbody");

  function getSelectedText(selectEl) {
    const opt = selectEl && selectEl.options && selectEl.options[selectEl.selectedIndex];
    return opt ? opt.textContent.trim() : "";
  }
  function getSelectedValue(selectEl) {
    const opt = selectEl && selectEl.options && selectEl.options[selectEl.selectedIndex];
    return opt ? (opt.value ?? "").trim() : "";
  }
  function extractCodeFromOption(optText) {
    // Try to pull a code like "LOB-001" if option text looks like "Legend of Blue Eyes (LOB-001)".
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
    // close handlers (x and OK) are wired in modal.js normally, but add safety:
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
    const name = (manualNameEl?.value || "").trim() || (ocrNameEl?.value || "").trim();
    const setText = getSelectedText(setSel);
    const rarity = getSelectedValue(raritySel) || getSelectedText(raritySel);
    const qty = parseInt(qtyEl?.value || "1", 10) || 1;
    const condition = getSelectedValue(conditionSel) || getSelectedText(conditionSel);
    // Try to infer a set code from the Set option text if present in parentheses:
    const code = extractCodeFromOption(setText);

    return {
      timestamp: new Date().toISOString(),
      name,
      set: setText,
      code,
      rarity,
      condition,
      qty,
      source: "scanner v5 (branch confirm)",
    };
  }

  function validateRow(row) {
    if (!row.name) return "Please choose a card name (Manual or Scanned).";
    if (!row.set) return "Please choose a Set.";
    if (!row.rarity) return "Please choose a Rarity.";
    if (!row.condition) return "Please choose a Condition.";
    if (!row.qty || row.qty < 1) return "Quantity must be at least 1.";
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
    // Keep OCR name; clear manual override and selections
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
      if (err) {
        showStatus(err, "error");
        console.warn("[confirm] validation failed:", err, row);
        return;
      }

      if (!window.Sheet || typeof window.Sheet.sendToSheet !== "function") {
        console.error("[confirm] Sheet.sendToSheet() is not available.");
        showStatus("Cannot post: Sheets client not ready.", "error");
        return;
      }

      console.log("[confirm] sending row:", row);
      await window.Sheet.sendToSheet(row); // fire-and-forget (no-cors under the hood)

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
    // Call the posting routine that mirrors "Post to Sheet" behavior
    await postCurrentSelection();
  });
  codeConfirmCancelBtn?.addEventListener("click", () => {
    closeCodeConfirmModal();
    showStatus("Canceled.", "info");
  });
  codeConfirmCloseX?.addEventListener("click", () => {
    closeCodeConfirmModal();
  });

  // --- Primary button on the form (labeled "Post to Sheet" in this branch) ---
  confirmBtn?.addEventListener("click", (e) => {
    e.preventDefault();

    // If your branch wants to show a code confirmation first, open it; otherwise post directly.
    const previewCode = extractCodeFromOption(getSelectedText(setSel));
    if (codeModal) {
      openCodeConfirmModal(previewCode);
    } else {
      // Fallback: no modal present, just post
      postCurrentSelection();
    }
  });

  // Give a clear log breadcrumb during testing
  console.log("[confirm] branch confirm.js initialized");
})();
