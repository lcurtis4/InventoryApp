// js/ui/state.js
(function(){
  window.UI = window.UI || {};
  const $ = (id) => document.getElementById(id);

  const State = {
    selectedCard: null,
    selectionConfirmed: false,
    selectedSetName: null,
    selectedRarity: null,
    selectedPrinting: null,
    selectedCondition: null,
    rows: [],
    MIN_ACCURACY: 55
  };

  function setConfirmButtonLabel(ready){
    const btn = $("confirmBtn");
    if (!btn) return;
    btn.textContent = ready ? "Post to Sheet" : "Confirm Card";
  }

  function enableQtyIfReady(){
    const btn = $("confirmBtn");
    const qtyEl = $("qty");
    if(!qtyEl || !btn) return;

    const qtyVal = Number(qtyEl.value || 0);
    const ready = Boolean(State.selectedCondition && qtyVal >= 1);
    btn.disabled = !ready;
    setConfirmButtonLabel(ready);
  }

  function resetFlowForNewPick(){
    State.selectionConfirmed = false;
    setConfirmButtonLabel(false);
    const btn = $("confirmBtn"); if(btn) btn.disabled = true;
    const qty = $("qty"); if(qty){ qty.value = "1"; qty.disabled = true; }
  }

  // ---- Single, global form reset used after successful post ---------------
  function resetSelectionForm(){
  // Clear dropdowns / inputs back to defaults and disable confirm
  const setSel = $("setSelect");
  const rarSel = $("raritySelect");
  const condSel = $("conditionSelect");
  const qty = $("qty");
  const confirmBtn = $("confirmBtn");

  if (setSel) setSel.value = "";
  if (rarSel) rarSel.value = "";
  if (condSel) condSel.value = "";
  if (qty) { qty.value = "1"; qty.disabled = true; }

  if (confirmBtn) {
    confirmBtn.disabled = true;
    setConfirmButtonLabel(false);
  }

  // Clear UI status text (best-effort)
  const clearText = (id) => { const el = $(id); if (el) el.textContent = ""; };
  clearText("lookupStatus");
  clearText("confirmStatus");
  clearText("confirmPickStatus");

  // Clear transient selection state
  State.selectedCard = null;
  State.selectedSetName = null;
  State.selectedRarity = null;
  State.selectedPrinting = null;
  State.selectedCondition = null;
  State.selectionConfirmed = false;

  // Clear manual override for next card
  const manual = $("manualName");
  if (manual) manual.value = "";

  // Clear the scanned/ocr name as well (covers common ids in this branch)
  ["ocrName", "scannedName", "scanName", "nameInput", "name"]
    .forEach(id => {
      const el = $(id);
      if (!el) return;
      if ("value" in el) el.value = "";
      else el.textContent = "";
    });

  // Optional: tiny probe to verify it fires
  try { console.log("[resetSelectionForm] fired"); } catch(_) {}
}

  // Expose API
  window.UI.State = State;
  window.UI.setConfirmButtonLabel = setConfirmButtonLabel;
  window.UI.enableQtyIfReady = enableQtyIfReady;
  window.UI.resetFlowForNewPick = resetFlowForNewPick;

  // Expose under both names that other modules check for
  window.resetSelectionForm = resetSelectionForm;
  window.resetForm = resetSelectionForm;
})();
