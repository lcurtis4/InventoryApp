// js/ui/index.js
(function () {
  /**
   * Helper to safely call a function and log if it fails.
   */
  function safe(fn, label) {
    try {
      if (typeof fn === "function") fn();
    } catch (e) {
      console.error(`[init] ${label} failed:`, e);
    }
  }

  window.addEventListener("DOMContentLoaded", function () {
    // Initialize modal (success popup)
    safe(() => window.UI?.modal?.init?.(), "modal.init");

    // Bind lookup (Find Printings flow)
    safe(() => window.UI?.lookup?.bind?.(), "lookup.bind");

    // Bind scanner (camera + OCR flow)
    safe(() => window.UI?.scan?.bind?.(), "scan.bind");

    // ⚠️ Do not manually bind confirm here.
    // js/ui/confirm.js self-attaches to #confirmBtn and related IDs.
    console.log("[init] UI boot complete");
  });
})();
