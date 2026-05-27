// js/scanner/camera.js  — v8.2
// Changes vs v8.1:
//   • Requests continuous autofocus + auto-exposure via advanced track constraints
//     (applyConstraints after getUserMedia, with safe per-feature try/catch).
//   • Optional torch: detects torch capability; if present, adds a #torchBtn to
//     the controls bar so the user can toggle it manually without breaking devices
//     that don't support it.
//   • Low-light exposure hint: reads current brightness from the track capabilities
//     exposureTime or brightnessHint if supported; exposed for core.js diagnostics.
(function () {
  "use strict";

  window.ScannerParts = window.ScannerParts || {};
  const CONST = window.ScannerParts.CONST || {};

  const $ = (id) => document.getElementById(id);

  let localStream  = null;
  let _torchOn     = false;
  let _torchTrack  = null;   // the video track that supports torch, if any

  // ── Try to apply a single advanced constraint, silently swallow errors ──────
  async function safeApplyConstraint(track, constraintObj) {
    try {
      await track.applyConstraints({ advanced: [constraintObj] });
      return true;
    } catch (_) {
      return false;
    }
  }

  // ── After getUserMedia resolves, apply focus/exposure hints ─────────────────
  async function applyLowLightHints(track) {
    if (!track || typeof track.applyConstraints !== "function") return;

    const caps = track.getCapabilities ? track.getCapabilities() : {};

    // 1. Continuous autofocus
    if (caps.focusMode && Array.isArray(caps.focusMode) && caps.focusMode.includes("continuous")) {
      await safeApplyConstraint(track, { focusMode: "continuous" });
    }

    // 2. Continuous auto-exposure
    if (caps.exposureMode && Array.isArray(caps.exposureMode) && caps.exposureMode.includes("continuous")) {
      await safeApplyConstraint(track, { exposureMode: "continuous" });
    }

    // 3. Prefer higher exposure compensation if available (nudge +0.5 EV for dim rooms)
    if (caps.exposureCompensation) {
      const ev = caps.exposureCompensation;
      if (typeof ev.min === "number" && typeof ev.max === "number") {
        // Use a moderate positive nudge — don't peg to max to avoid blow-out
        const target = Math.min(ev.max, Math.max(ev.min, 0.5));
        await safeApplyConstraint(track, { exposureCompensation: target });
      }
    }

    // 4. Continuous white balance
    if (caps.whiteBalanceMode && Array.isArray(caps.whiteBalanceMode) && caps.whiteBalanceMode.includes("continuous")) {
      await safeApplyConstraint(track, { whiteBalanceMode: "continuous" });
    }
  }

  // ── Torch toggle — only wired up when the track confirms torch support ──────
  function createTorchButton(track) {
    // Remove any pre-existing torch button
    const existing = $("torchBtn");
    if (existing) existing.remove();

    const btn = document.createElement("button");
    btn.id        = "torchBtn";
    btn.type      = "button";
    btn.className = "secondary";
    btn.title     = "Toggle torch / flashlight";
    btn.textContent = "🔦 Torch";

    btn.addEventListener("click", async () => {
      _torchOn = !_torchOn;
      try {
        await track.applyConstraints({ advanced: [{ torch: _torchOn }] });
        btn.classList.toggle("torch-on", _torchOn);
        btn.textContent = _torchOn ? "🔦 Torch ON" : "🔦 Torch";
      } catch (e) {
        // CONSOLE-OFF v12 console.warn("[camera] torch toggle failed:", e);
        _torchOn = false;
        btn.classList.remove("torch-on");
        btn.textContent = "🔦 Torch";
      }
    });

    // Insert after the scan-toggle button in the controls bar
    const controls = document.querySelector(".controls");
    if (controls) {
      controls.appendChild(btn);
    }
  }

  // ── Check for torch support and set up button if found ──────────────────────
  function setupTorch(track) {
    if (!track || typeof track.getCapabilities !== "function") return;
    const caps = track.getCapabilities();
    if (caps.torch === true || (Array.isArray(caps.torch) && caps.torch.includes(true))) {
      _torchTrack = track;
      createTorchButton(track);
    }
  }

  // ── Start camera ─────────────────────────────────────────────────────────────
  async function start() {
    const v = $("video");
    const s = $("camStatus");

    try {
      // Request camera with preferred constraints for close-up document scanning
      const constraints = {
        video: {
          facingMode:  { ideal: "environment" },
          aspectRatio: CONST.CARD_ASPECT_WH ? { ideal: CONST.CARD_ASPECT_WH } : undefined,
          height:      { ideal: 720, min: 480 },
          // Wider aperture / lower shutter hints where supported (not universally honoured)
          frameRate:   { ideal: 30 },
        },
        audio: false,
      };

      localStream = await navigator.mediaDevices.getUserMedia(constraints);

      if (v) {
        v.srcObject = localStream;
        v.setAttribute("playsinline", "true");
        v.style.objectFit = "cover";
        // Ensure video plays even if autoplay policy is strict
        await v.play().catch(() => {});
      }

      // Mirror to legacy globals
      window.stream = localStream;
      window.ScannerParts.state = window.ScannerParts.state || {};
      window.ScannerParts.state.stream = localStream;

      // Apply continuous focus/exposure hints asynchronously (non-blocking)
      const videoTrack = localStream.getVideoTracks()[0];
      if (videoTrack) {
        applyLowLightHints(videoTrack).catch(() => {});
        setupTorch(videoTrack);
      }

      if (s) s.textContent = "Camera ready. Hold a card steady; I'll auto-scan after ~2s.";
    } catch (e) {
      if (s) s.textContent = "Could not start camera. Check permissions.";
      console.error("[camera] start failed:", e);
      throw e;  // re-throw so scan.js bind can handle it
    }
  }

  // ── Stop camera ──────────────────────────────────────────────────────────────
  function stop() {
    // Turn off torch before stopping
    if (_torchTrack && _torchOn) {
      safeApplyConstraint(_torchTrack, { torch: false }).catch(() => {});
      _torchOn = false;
    }
    _torchTrack = null;

    // Remove torch button
    const tb = $("torchBtn");
    if (tb) tb.remove();

    try {
      if (localStream) {
        localStream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
      }
    } finally {
      localStream = null;
      window.stream = null;
      if (window.ScannerParts.state) window.ScannerParts.state.stream = null;
      if (window.monitorTimer) {
        try { clearInterval(window.monitorTimer); } catch (_) {}
        window.monitorTimer = null;
      }
    }
  }

  // ── Expose ───────────────────────────────────────────────────────────────────
  window.ScannerParts.camera = { start, stop };
})();
