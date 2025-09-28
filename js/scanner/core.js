// js/scanner/core.js
(function () {
  window.ScannerParts = window.ScannerParts || {};

  // ----- Safe DOM + 2D context helpers -----
  const $ = window.$ || ((id) => document.getElementById(id));
  const get2d = (canvas) => {
    if (!canvas) return null;
    if (window.ScannerParts.ctx2d && typeof window.ScannerParts.ctx2d === "function") {
      return window.ScannerParts.ctx2d(canvas);
    }
    return canvas.getContext("2d");
  };
  const firstById = (ids) => {
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) return el;
    }
    return null;
  };

  // ----- Local state -----
  let monitorTimer = null;
  let paused = false;
  let cooldown = false;
  let stableMs = 0;
  let lastVec = null;

  // Debug/bookkeeping
  let _lastDetectedRect = null;
  let _lastDbgAcc = null;
  let _lastDbgSrc = null;
  let _lastDbgText = null;
  let _lastFrameSize = null;

  // ----- Constants (from js/scanner/constants.js) -----
  const C = window.ScannerParts.CONST || {};
  const SAMPLE_INTERVAL_MS = Number(C.SAMPLE_INTERVAL_MS || 160);
  const STABLE_WINDOW_MS   = Number(C.STABLE_WINDOW_MS   || 450);
  const MOVEMENT_THRESHOLD = Number(C.MOVEMENT_THRESHOLD || 9.0);
  const MIN_CONTRAST       = Number(C.MIN_CONTRAST       || 8.0);

  // Expose last detected rect for overlay/debuggers
  window.ScannerParts._internal = window.ScannerParts._internal || {};
  window.ScannerParts._internal.lastDetectedRect = () => _lastDetectedRect;

  // ----- Ensure a work canvas exists (offscreen) -----
  function ensureWorkCanvas() {
    let c = $("workCanvas") || document.getElementById("work-canvas");
    if (!c) {
      c = document.createElement("canvas");
      c.id = "workCanvas";
      c.style.display = "none";
      (document.body || document.documentElement).appendChild(c);
    }
    return c;
  }

  // ----- Debug helpers (compatible with your existing debug panel) -----
  function getDebugCanvas() {
    let dbg = firstById(["debugCanvas", "debug-canvas", "debugCrop", "debug_crop"]);
    if (dbg && !(dbg instanceof HTMLCanvasElement)) {
      const found = dbg.querySelector && dbg.querySelector("canvas");
      if (found) dbg = found;
      else {
        const c = document.createElement("canvas");
        c.width = 320; c.height = 120;
        c.style.width = "100%";
        c.style.display = "block";
        dbg.appendChild(c);
        dbg = c;
      }
    }
    if (!dbg) {
      const host = $("video")?.parentElement || document.body;
      const wrap = document.createElement("div");
      wrap.style.marginTop = "8px";
      const title = document.createElement("div");
      title.textContent = "Debug preview (last crop)";
      title.style.font = "600 12px system-ui,-apple-system,Segoe UI,Roboto,Arial";
      title.style.margin = "0 0 6px 0";
      dbg = document.createElement("canvas");
      dbg.id = "debugCanvas";
      dbg.width = 320; dbg.height = 120;
      dbg.style.width = "100%";
      dbg.style.display = "block";
      dbg.style.background = "#111";
      dbg.style.borderRadius = "4px";
      wrap.appendChild(title);
      wrap.appendChild(dbg);
      host.appendChild(wrap);
    }
    return dbg;
  }

  function pickSourceCanvas(src) {
    if (!src) return null;
    if (src instanceof HTMLCanvasElement) return src;
    if (src._canvas instanceof HTMLCanvasElement) return src._canvas;
    if (src.pre instanceof HTMLCanvasElement) return src.pre;
    if (typeof OffscreenCanvas !== "undefined" && src instanceof OffscreenCanvas) return src;
    return null;
  }

  function showDebug(src, info) {
    _lastDbgSrc = src;
    if (info && typeof info.text === "string") _lastDbgText = info.text;

    const dbg = getDebugCanvas();
    const ctx = get2d(dbg);
    if (!ctx) return;

    const canvas = pickSourceCanvas(src);
    if (canvas) {
      if (dbg.width !== canvas.width)  dbg.width  = canvas.width;
      if (dbg.height !== canvas.height) dbg.height = canvas.height;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, dbg.width, dbg.height);
      ctx.drawImage(canvas, 0, 0, dbg.width, dbg.height);
    } else {
      ctx.clearRect(0, 0, dbg.width, dbg.height);
    }

    if (info) {
      ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto, Arial";
      ctx.fillStyle = "#e6e6e6";
      const msg = [
        info.text || "",
        (typeof info.accuracy === "number") ? `acc: ${info.accuracy}%` : ""
      ].filter(Boolean).join("  •  ");
      if (msg) {
        const pad = 4;
        const y = Math.max(12, dbg.height - 4);
        ctx.fillStyle = "rgba(0,0,0,.55)";
        ctx.fillText(msg, pad + 1, y + 1);
        ctx.fillStyle = "#e6e6e6";
        ctx.fillText(msg, pad, y);
      }
    }
  }

  function setDebugAccuracy(pct) {
    if (typeof pct !== "number") _lastDbgAcc = null;
    else _lastDbgAcc = Math.max(0, Math.min(100, Math.round(pct)));
    if (_lastDbgSrc) {
      showDebug(_lastDbgSrc, { text: _lastDbgText, accuracy: _lastDbgAcc });
    }
  }

  // Make it available to ocr.js (which checks ScannerParts.debug.show or window.showDebug)
  window.ScannerParts.debug = window.ScannerParts.debug || {};
  window.ScannerParts.debug.show = showDebug;
  window.showDebug = showDebug;

  // ----- Frame copy from <video> to an offscreen canvas -----
  function drawFrame() {
    const v = $("video");
    if (!v || !v.videoWidth) return null;
    const c = ensureWorkCanvas();
    c.width = v.videoWidth;
    c.height = v.videoHeight; // native pixels
    _lastFrameSize = { w: c.width, h: c.height };
    const ctx = get2d(c);
    if (!ctx) return null;
    ctx.drawImage(v, 0, 0, c.width, c.height);
    return c;
  }

  // ----- Pause / Resume used by the UI -----
  function pause() { paused = true; }
  function resume() {
    paused = false;
    stableMs = 0;
    lastVec = null;
  }

  // ----- Monitoring loop: find band → stability → OCR → overlay -----
  function startMonitor(onFound, onState) {
    if (monitorTimer) clearInterval(monitorTimer);
    paused = false;
    cooldown = false;
    stableMs = 0;
    lastVec = null;

    monitorTimer = setInterval(async () => {
      if (!window.stream) return;

      if (window.ScannerParts.overlay && typeof window.ScannerParts.overlay.syncOverlaySize === "function") {
        window.ScannerParts.overlay.syncOverlaySize();
      }

      if (paused) {
        if (window.ScannerParts.overlay && typeof window.ScannerParts.overlay.drawOverlay === "function") {
          window.ScannerParts.overlay.drawOverlay("paused", _lastDetectedRect);
        }
        onState && onState("paused", 0, {});
        return;
      }

      const frame = drawFrame();
      if (!frame) return;

      // Locate the title band
      const band = window.ScannerParts.geometry.findTitleBand(frame);
      const rect = band._rect;
      _lastDetectedRect = rect;

      // If the band is too empty/low contrast, bail early
      if (band._tooEmpty) {
        onState && onState("lowlight", 0, { rect, note: "empty-band" });
        if (window.ScannerParts.overlay && typeof window.ScannerParts.overlay.drawOverlay === "function") {
          window.ScannerParts.overlay.drawOverlay("lowlight", rect, 0);
        }
        stableMs = 0;
        showDebug(band, { text: "(no OCR — band too empty/low-contrast)" });
        return;
      }

      // Motion/contrast checks
      const vec = window.ScannerParts.band.grayscaleVector(band);
      const delta = window.ScannerParts.band.meanAbsDiff(vec, lastVec);
      lastVec = vec;
      const contrast = window.ScannerParts.band.contrastEstimate(vec);

      let state = "search";
      if (delta > MOVEMENT_THRESHOLD) {
        stableMs = 0;
        state = "moving";
      } else if (contrast < MIN_CONTRAST) {
        stableMs = 0;
        state = "lowlight";
      } else {
        stableMs += SAMPLE_INTERVAL_MS;
        state = (stableMs >= STABLE_WINDOW_MS) ? "scanning" : "steady";
      }

      onState && onState(state, stableMs, { rect, delta, contrast });
      if (window.ScannerParts.overlay && typeof window.ScannerParts.overlay.drawOverlay === "function") {
        window.ScannerParts.overlay.drawOverlay(state, rect, stableMs);
      }

      // Trigger OCR once stable
      if (state === "scanning" && !cooldown) {
        cooldown = true;
        try {
          const best = await window.ScannerParts.ocr.scanBand(band);
          stableMs = 0;
          lastVec = null;

          const srcForDebug = (best && best.pre) ? best.pre : band;
          _lastDbgSrc = srcForDebug;
          _lastDbgText = (best && best.text) ? best.text : "(no text)";
          showDebug(_lastDbgSrc, { text: _lastDbgText, accuracy: _lastDbgAcc });

          // --- NEW: If no onFound is supplied, auto-resolve and pause on accepted match ---
          if (best) {
            if (typeof onFound === "function") {
              onFound(best);
            } else {
              // Try both API and Resolve surfaces
              const L = window.Lookup || {};
              const LP = window.LookupParts || {};
              const api = LP.api || L;
              const res = (api && (api.resolveNameFromScanNgrams || (api.resolve && api.resolve.resolveNameFromScanNgrams))) ||
                          (L.resolveNameFromScanNgrams || (L.resolve && L.resolve.resolveNameFromScanNgrams));

              let resolved = "";
              try {
                if (typeof res === "function") {
                  resolved = await res({ scannedName: String(best.text || "").trim() });
                }
              } catch (_) {}

              if (resolved) {
                // Stop the scanner immediately
                pause();

                // Let a UI shim set the field if present
                try {
                  if (L && typeof L.setCardName === "function") L.setCardName(resolved);
                } catch (_) {}

                // Broadcast a DOM event so app code can react
                try {
                  const evt = new CustomEvent("scanner:card-found", {
                    detail: { ocr: best.text || "", name: resolved, rect }
                  });
                  window.dispatchEvent(evt);
                } catch (_) {}

                // Optional: show a nice accuracy hint if normalize.sim is available
                try {
                  const N = LP.normalize || L.normalize || {};
                  if (N && typeof N.sim === "function") {
                    const pct = Math.round(N.sim(best.text || "", resolved) * 100);
                    setDebugAccuracy(pct);
                  }
                } catch (_) {}
              }
            }
          }
        } finally {
          setTimeout(() => { cooldown = false; }, 800);
        }
      }
    }, SAMPLE_INTERVAL_MS);
  }

  // ----- Public Scanner facade used by the UI -----
  window.Scanner = {
    start: () => window.ScannerParts.camera.start(),
    stop: () => {
      if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
      return window.ScannerParts.camera.stop();
    },
    startMonitor,
    pause,
    resume,
    setDebugAccuracy,
  };
})();
