// js/ui/confirm.js — vCONF-8
// Handles confirm flow, posting, recent grid, and robust reset after success.

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

  // Shared state
  const UI = (window.UI = window.UI || {});
  const State = (UI.State = UI.State || {});

  // Modals
  const codeModal = $("#codeConfirmModal");
  const codeConfirmText = $("#codeConfirmText");
  const codeConfirmCloseX = $("#codeConfirmCloseX");
  const codeConfirmCancelBtn = $("#codeConfirmCancelBtn");
  const codeConfirmConfirmBtn = $("#codeConfirmConfirmBtn");

  const successModal = $("#successModal");
  const successModalBody = $("#successModalBody");

  // Recent grid
  const gridBody = document.querySelector("#grid tbody");

  // Submit guard
  let inFlight = false;

  // --- Select helpers ---
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
    const name = (manualNameEl?.value || "").trim() || (ocrNameEl?.value || "").trim();

    const setName  = State?.selectedSetName || getSelectedValue(setSel) || getSelectedText(setSel);
    const rarity   = State?.selectedRarity  || getSelectedValue(raritySel) || getSelectedText(raritySel);
    const printing = State?.selectedPrinting || null;

    let code = printing?.set_code || "";
    if (!code) code = extractCodeFromOption(getSelectedText(setSel));

    const qty       = parseInt(qtyEl?.value || "1", 10) || 1;
    const condition = getSelectedValue(conditionSel) || getSelectedText(conditionSel);

    const system =
      (window.APP_CONFIG?.DEVICE_NAME ?? window.APP_CONFIG?.deviceName) ||
      window.UI?.State?.deviceName ||
      "desktop";
    State.source = system;

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
    return null;
  }

  // De-dup recent grid
  function appendToRecentGrid(row) {
    if (!gridBody) return;

    const norm = (s) => (s ?? "").toString().trim();

    const key = [
      norm(row.name),
      norm(row.set),
      norm(row.code || ""),
      norm(row.rarity),
      norm(row.condition || "")
    ].join("||");

    const trs = Array.from(gridBody.querySelectorAll("tr"));
    for (const tr of trs) {
      const tds = tr.children;
      if (tds.length < 7) continue;

      const existingKey = [
        norm(tds[0].textContent),
        norm(tds[1].textContent),
        norm(tds[2].textContent),
        norm(tds[3].textContent),
        norm(tds[4].textContent)
      ].join("||");

      if (existingKey === key) {
        const current = parseInt(norm(tds[5].textContent) || "0", 10) || 0;
        const add = parseInt(row.qty, 10) || 0;
        tds[5].textContent = String(current + add);
        tds[6].textContent = "✅"
        return;
      }
    }

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.name}</td>
      <td>${row.set}</td>
      <td>${row.code || ""}</td>
      <td>${row.rarity}</td>
      <td>${row.condition}</td>
      <td>${row.qty}</td>
      <td>✅</td>
    `;
    gridBody.prepend(tr);
  }

  // ---- STRONG RESET (with change events) ----
  function resetDropdown(selectEl) {
    if (!selectEl) return;
    selectEl.selectedIndex = 0;                    // visual reset
    selectEl.value = selectEl.options?.[0]?.value || ""; // programmatic
    // Dispatch real change so any listeners (lookup, validators, etc.) react
    selectEl.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function resetForm() {
    // Inputs
    if (manualNameEl) manualNameEl.value = "";
    if (qtyEl) { qtyEl.value = "1"; qtyEl.disabled = true; }

    // Dropdowns (fire change so downstream logic clears too)
    resetDropdown(setSel);
    resetDropdown(raritySel);
    resetDropdown(conditionSel);

    // Transient state
    State.selectedSetName = null;
    State.selectedRarity = null;
    State.selectedPrinting = null;

    // Disable the Post/Confirm button until new valid selections are made
    if (confirmBtn) confirmBtn.disabled = true;

    // Clear status
    if (confirmStatus) {
      confirmStatus.textContent = "";
      confirmStatus.className = "status";
    }

    // Optional: publish a reset event other modules can listen for
    document.dispatchEvent(new CustomEvent("inventory:form:reset"));
  }

  async function postCurrentSelection() {
    if (inFlight) return;
    try {
      inFlight = true;
      if (confirmBtn) confirmBtn.disabled = true;
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

      // Critical: fully reset so another click can't re-post same payload
      resetForm();
      showStatus("Ready for next card.", "ok");
    } catch (e) {
      console.error("[confirm] post failed:", e);
      showStatus("Failed to post. See console.", "error");
    } finally {
      inFlight = false;
    }
  }

  // --- Wire up modal buttons ---
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

  // --- Primary button ---
  confirmBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    if (inFlight) return;

    const previewCode =
      (State?.selectedPrinting?.set_code) || extractCodeFromOption(getSelectedText(setSel));
    if (codeModal) {
      openCodeConfirmModal(previewCode);
    } else {
      postCurrentSelection();
    }
  });

  // Ensure button starts disabled until valid selection flow
  if (confirmBtn) confirmBtn.disabled = true;

  console.log("[confirm] confirm.js initialized :: vCONF-8");
})();
