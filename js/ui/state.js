// js/ui/state.js  — v7: localStorage persistence for last-used condition and quantity
(function(){
  window.UI = window.UI || {};
  const $ = (id) => document.getElementById(id);

  // ---- localStorage helpers ------------------------------------------------
  const LS_CONDITION_KEY = "ygo_last_condition";
  const LS_QTY_KEY       = "ygo_last_qty";

  function loadPersistedCondition() {
    try { return localStorage.getItem(LS_CONDITION_KEY) || ""; } catch { return ""; }
  }
  function savePersistedCondition(val) {
    try { if (val) localStorage.setItem(LS_CONDITION_KEY, val); } catch {}
  }
  function loadPersistedQty() {
    try { const v = parseInt(localStorage.getItem(LS_QTY_KEY) || "1", 10); return (v >= 1 ? v : 1); } catch { return 1; }
  }
  function savePersistedQty(val) {
    try { const n = parseInt(val, 10); if (n >= 1) localStorage.setItem(LS_QTY_KEY, String(n)); } catch {}
  }

  // v24 (#24): on fresh page load, show the unified "please select" placeholder
  // for Condition (matching Set/Rarity) instead of auto-restoring last-used value.
  // Persistence still happens on `change` so the user's last pick is saved —
  // it just no longer pre-fills the field at startup. The user must actively
  // choose a condition each session.
  function restoreCondition() {
    const sel = $("conditionSelect");
    if (sel) sel.value = "";
  }

  // Apply last-used quantity to the qty field on page load
  function restoreQty() {
    const qty = $("qty");
    if (qty) qty.value = String(loadPersistedQty());
  }

  // ---- State object --------------------------------------------------------
  const State = {
    selectedCard: null,
    selectionConfirmed: false,
    selectedSetName: null,
    selectedRarity: null,
    selectedPrinting: null,
    selectedCondition: null,
    rows: [],
    MIN_ACCURACY: 55,
    // Persistence helpers exposed on State for confirm.js / other modules
    savePersistedCondition,
    savePersistedQty,
    loadPersistedCondition,
    loadPersistedQty,
  };

  function setConfirmButtonLabel(toAddMode){
    const btn = $("confirmBtn");
    if(!btn) return;
    btn.textContent = toAddMode ? "Add to Sheet" : "Post to Sheet";
    btn.classList.toggle("primary", toAddMode);
    btn.classList.toggle("secondary", !toAddMode);
  }

  function enableQtyIfReady(){
    // Fix 4 (v14.1): Post button now requires name + set + rarity + condition + qty.
    // Set and Rarity are only required when their dropdowns have been populated
    // (options.length > 1 means the placeholder + at least one real option).
    // This prevents posting a card with only Condition filled.
    const qty = $("qty");
    const btn = $("confirmBtn");
    if(!qty || !btn) return;

    const manualName  = ($("manualName")?.value || "").trim();
    const scannedName = ($("ocrName")?.value    || "").trim();
    const haveName    = !!(manualName || scannedName);
    const haveCondition = !!State.selectedCondition;

    // Require Set / Rarity only when their dropdowns have been populated
    const setSel    = $("setSelect");
    const rarSel    = $("raritySelect");
    const setPopulated    = setSel  && setSel.options.length  > 1;
    const rarityPopulated = rarSel  && rarSel.options.length  > 1;
    const haveSet    = !setPopulated    || !!(State.selectedSetName);
    const haveRarity = !rarityPopulated || !!(State.selectedRarity);

    const minReady = haveName && haveCondition && haveSet && haveRarity;

    qty.disabled = !minReady;
    const qtyVal = parseInt(qty.value || "0", 10);
    if (!State.selectionConfirmed) btn.disabled = !(minReady && qtyVal >= 1);
    else btn.disabled = !(qtyVal >= 1);
  }

  function resetFlowForNewPick(){
    State.selectionConfirmed = false;
    setConfirmButtonLabel(false);
    const btn = $("confirmBtn"); if(btn) btn.disabled = true;
    // v7: restore persisted qty instead of always resetting to 1
    const qty = $("qty");
    if(qty){
      qty.value = String(loadPersistedQty());
      qty.disabled = true;
    }
  }

  // Wire up condition select to persist on change
  window.addEventListener("DOMContentLoaded", function() {
    const condSel = $("conditionSelect");
    if (condSel) {
      condSel.addEventListener("change", function() {
        savePersistedCondition(this.value);
      });
    }
    const qtyEl = $("qty");
    if (qtyEl) {
      qtyEl.addEventListener("change", function() {
        savePersistedQty(this.value);
      });
    }

    // Restore persisted values
    restoreCondition();
    restoreQty();
  });

  window.UI.State = State;
  window.UI.setConfirmButtonLabel = setConfirmButtonLabel;
  window.UI.enableQtyIfReady = enableQtyIfReady;
  window.UI.resetFlowForNewPick = resetFlowForNewPick;
})();
