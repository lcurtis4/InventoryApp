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

  function setConfirmButtonLabel(toAddMode){
    const btn = $("confirmBtn");
    if(!btn) return;
    btn.textContent = toAddMode ? "Add to Sheet" : "Post to Sheet";
    btn.classList.toggle("primary", toAddMode);
    btn.classList.toggle("secondary", !toAddMode);
  }

  function enableQtyIfReady(){
    const qty = $("qty");
    const btn = $("confirmBtn");
    if(!qty || !btn) return;
    const ready = !!(State.selectedSetName && State.selectedRarity && State.selectedCondition);
    qty.disabled = !ready;
    const qtyVal = parseInt(qty.value || "0", 10);
    if (!State.selectionConfirmed) btn.disabled = !(ready && qtyVal >= 1);
    else btn.disabled = !(qtyVal >= 1);
  }

  function resetFlowForNewPick(){
    State.selectionConfirmed = false;
    setConfirmButtonLabel(false);
    const btn = $("confirmBtn"); if(btn) btn.disabled = true;
    const qty = $("qty"); if(qty){ qty.value = "1"; qty.disabled = true; }
  }

  window.UI.State = State;
  window.UI.setConfirmButtonLabel = setConfirmButtonLabel;
  window.UI.enableQtyIfReady = enableQtyIfReady;
  window.UI.resetFlowForNewPick = resetFlowForNewPick;
})();