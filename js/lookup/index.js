// js/lookup/index.js — safe aggregator for legacy callers
(function () {
  'use strict';

  const LP = window.LookupParts || {};
  const A  = LP.api       || {};
  const N  = LP.normalize || {};
  const R  = LP.resolve   || {};
  const U  = LP.ui || (window.Lookup && window.Lookup.ui) || {};

  const noop = () => {};
  const noopAsync = async () => {};

  const init   = (typeof U.init === 'function') ? U.init : noop;
  const setCardName = (typeof U.setCardName === 'function') ? U.setCardName : noop;
  const getSelection = (typeof U.getSelection === 'function') ? U.getSelection : () => null;

  const resolveNameFromScanNgrams =
    (typeof R.resolveNameFromScanNgrams === 'function') ? R.resolveNameFromScanNgrams : noopAsync;

  const fetchCandidates =
    (typeof A.fetchCandidates === 'function') ? A.fetchCandidates : async () => [];

  const bestNameMatch =
    (typeof A.bestNameMatch === 'function') ? A.bestNameMatch :
    (typeof N.bestNameMatch === 'function') ? N.bestNameMatch :
    () => 0;

  // Expose a stable Lookup surface for any legacy callers
  window.Lookup = Object.assign(window.Lookup || {}, {
    init,
    setCardName,
    getSelection,
    resolveNameFromScanNgrams,
    fetchCandidates,
    bestNameMatch
  });

  // Legacy alias
  window.lookup = window.Lookup;

  // Optional: auto-init if present (won't throw if it's a no-op)
  try { init(); } catch (e) { console.error('[lookup/index] init failed:', e); }
})();
