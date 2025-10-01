// js/ui/confirm/state.js
// -----------------------------------------------------------------------------
// In-memory state + refs (recentMap, pendingRow, handlers, DOM refs)
// -----------------------------------------------------------------------------
(function () {
  'use strict';

  const { SELECTORS, q } = window.ConfirmUI;

  // DOM refs (robust/fallback)
  const modalEl   = q(SELECTORS.modalRoot);
  const btnYes    = q(SELECTORS.btnConfirm);
  const btnNo     = q(SELECTORS.btnCancel);
  const summaryEl = q(SELECTORS.summaryBox);

  const gridEl    = q(SELECTORS.recentTable);
  const gridBody  = q(SELECTORS.recentTbody);

  // State
  const recentMap = new Map(); // key => row
  let pendingRow = null;
  let postToSheetHandler = null;

  // Accessors
  function getRecentMap() { return recentMap; }
  function getPendingRow() { return pendingRow; }
  function setPendingRow(r) { pendingRow = r; }
  function getPostHandler() { return postToSheetHandler; }
  function setPostHandler(fn) { postToSheetHandler = fn; }

  window.ConfirmUI = window.ConfirmUI || {};
  window.ConfirmUI.state = {
    modalEl, btnYes, btnNo, summaryEl, gridEl, gridBody,
    getRecentMap, getPendingRow, setPendingRow,
    getPostHandler, setPostHandler
  };
})();