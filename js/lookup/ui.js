// js/lookup/ui.js
(function () {
  'use strict';

  // Legacy shim: older loader calls Lookup.ui.init()
  // v5.1 UI handles the interactive DOM; this keeps legacy bootstrap happy.
  window.Lookup = window.Lookup || {};

  const UI = {
    init() {
      // No-op: v5.1 UI binds all required handlers.
      // If you later want this to do something,
      // you could hook up extra diagnostics here.
      if (window.console && console.debug) {
        console.debug("[lookup/ui] init() shim loaded");
      }
    }
  };

  window.Lookup.ui = UI;
})();
