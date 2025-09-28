// js/scanner/camera.js
(function () {
  // Ensure namespace
  window.ScannerParts = window.ScannerParts || {};
  const CONST = window.ScannerParts.CONST || {};

  // Safe DOM helper
  const $ = window.$ || ((id) => document.getElementById(id));

  // Local handle to the active MediaStream
  let localStream = null;

  // Start camera and attach to <video id="video">
  async function start() {
    const v = $("video");
    try {
      const constraints = {
        video: {
          facingMode: "environment",
          // If you’ve defined CARD_ASPECT_WH in CONST (≈0.686), this hints at a card-like frame
          aspectRatio: CONST.CARD_ASPECT_WH ? { ideal: CONST.CARD_ASPECT_WH } : undefined,
          height: { ideal: 720 }
        },
        audio: false
      };

      localStream = await navigator.mediaDevices.getUserMedia(constraints);
      if (v) {
        v.srcObject = localStream;
        v.setAttribute("playsinline", "true");
        v.style.objectFit = "cover";
      }

      // Mirror to legacy globals so the rest of the pipeline sees it
      window.stream = localStream;
      window.ScannerParts.state = window.ScannerParts.state || {};
      window.ScannerParts.state.stream = localStream;

      const s = $("camStatus");
      if (s) s.textContent = "Camera ready. Hold a card steady; I’ll auto-scan after ~2s.";
    } catch (e) {
      const s = $("camStatus");
      if (s) s.textContent = "Could not start camera. Check permissions.";
      console.error("camera.start failed:", e);
    }
  }

  // Stop camera and clean up
  function stop() {
    try {
      if (localStream) {
        localStream.getTracks().forEach((t) => {
          try { t.stop(); } catch (_) {}
        });
      }
    } finally {
      // Clear local and mirrored references
      localStream = null;
      window.stream = null;
      if (window.ScannerParts.state) window.ScannerParts.state.stream = null;

      // Older code may have a global monitor timer—clear defensively
      if (window.monitorTimer) {
        try { clearInterval(window.monitorTimer); } catch (_) {}
        window.monitorTimer = null;
      }
    }
  }

  // Expose in namespace
  window.ScannerParts.camera = { start, stop };
})();
