// js/ui/confirm/selectors.js
// -----------------------------------------------------------------------------
// Centralized selectors + query helpers
// -----------------------------------------------------------------------------
(function () {
  'use strict';

  const SELECTORS = {
    modalRoot: '#confirmModal, .confirm-modal, #postConfirmModal',
    btnConfirm: '#confirmYes, .btn-confirm, [data-confirm="yes"]',
    btnCancel:  '#confirmNo, .btn-cancel,  [data-confirm="no"]',
    summaryBox: '.confirm-summary, #confirmSummary',
    recentTable: '#grid, #recent-grid, #recentItemsGrid',
    recentTbody: '#grid tbody, #recent-grid tbody, #recentItemsGrid tbody'
  };

  function q(sel) { return document.querySelector(sel); }
  function qa(sel) { return Array.from(document.querySelectorAll(sel)); }

  // Expose under a single namespace
  window.ConfirmUI = window.ConfirmUI || {};
  window.ConfirmUI.SELECTORS = SELECTORS;
  window.ConfirmUI.q = q;
  window.ConfirmUI.qa = qa;
})();