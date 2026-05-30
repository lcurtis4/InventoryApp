// js/scanner/core.js
//
// Automatic scanner — NAME-ONLY detection (issue #54 removed the set-code OCR
// pipeline). On each stable frame: detect the title band (geometry.js), OCR the
// name (ocr.js), resolve candidates from the local DB (resolve.js), rank them
// with image assist (non-blocking, capped at IMAGE_ASSIST_TIMEOUT_MS), then fire
// onFound exactly once. The scan loop's cooldown prevents overlapping scans.
//
// Manual set-code entry is unaffected and lives in the UI layer
// (js/ui/lookup.js + js/ui/scan.js → codeSearch.resolveCode).

(function () {
  "use strict";

  window.ScannerParts = window.ScannerParts || {};

  // ── DOM helpers ──────────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const get2d = (canvas) => {
    if (!canvas) return null;
    if (window.ScannerParts.ctx2d && typeof window.ScannerParts.ctx2d === "function") {
      return window.ScannerParts.ctx2d(canvas);
    }
    // The work/frame canvas is read back via getImageData on every monitor
    // tick, so request willReadFrequently:true to avoid the Canvas2D readback
    // warning and speed up repeated reads (#68).
    return canvas.getContext
      ? canvas.getContext("2d", { willReadFrequently: true })
      : null;
  };
  const firstById = (ids) => {
    for (const id of ids) { const el = $(id); if (el) return el; }
    return null;
  };

  // ── Scan state ───────────────────────────────────────────────────────────────
  let monitorTimer = null;
  let paused       = false;
  let cooldown     = false;
  let stableMs     = 0;
  let lastVec      = null;

  let _lastDetectedRect = null;
  let _lastDbgAcc       = null;
  let _lastDbgSrc       = null;
  let _lastDbgText      = null;

  const C = window.ScannerParts.CONST || {};
  const SAMPLE_INTERVAL_MS = Number(C.SAMPLE_INTERVAL_MS || 500);
  const STABLE_WINDOW_MS   = Number(C.STABLE_WINDOW_MS   || 350);
  const MOVEMENT_THRESHOLD = Number(C.MOVEMENT_THRESHOLD || 12.0);
  const MIN_CONTRAST       = Number(C.MIN_CONTRAST       || 6.0);

  // How long to wait for image assist to re-rank before firing without it.
  // Keep short so the UI feels snappy; image assist improving ranking is a bonus.
  const IMAGE_ASSIST_TIMEOUT_MS = 1200;

  // Minimum score to include a candidate at all.
  const ACCEPTABLE_SCORE   = 0.65;

  window.ScannerParts._internal = window.ScannerParts._internal || {};
  window.ScannerParts._internal.lastDetectedRect = () => _lastDetectedRect;

  // ── Work canvas ──────────────────────────────────────────────────────────────
  function ensureWorkCanvas() {
    let c = $("workCanvas");
    if (!c) {
      c = document.createElement("canvas");
      c.id = "workCanvas"; c.style.display = "none";
      (document.body || document.documentElement).appendChild(c);
    }
    return c;
  }

  // ── Name-band debug canvas (#debugCanvas) ───────────────────────────────────
  function getDebugCanvas() {
    let dbg = firstById(["debugCanvas", "debug-canvas", "debugCrop", "debug_crop"]);
    if (dbg && !(dbg instanceof HTMLCanvasElement)) {
      const found = dbg.querySelector && dbg.querySelector("canvas");
      if (found) { dbg = found; }
      else {
        const c = document.createElement("canvas");
        c.width = 320; c.height = 120; c.style.width = "100%"; c.style.display = "block";
        dbg.appendChild(c); dbg = c;
      }
    }
    if (!dbg) {
      const host = $("video")?.parentElement || document.body;
      const wrap = document.createElement("div"); wrap.style.marginTop = "8px";
      dbg = document.createElement("canvas");
      dbg.id = "debugCanvas"; dbg.width = 320; dbg.height = 120;
      dbg.style.cssText = "width:100%;display:block;background:#111;border-radius:4px;";
      wrap.appendChild(dbg); host.appendChild(wrap);
    }
    return dbg;
  }

  function drawToCanvas(target, src, labelText) {
    if (!target) return;
    const ctx = get2d(target);
    if (!ctx) return;
    let srcCanvas = null;
    if (src instanceof HTMLCanvasElement) srcCanvas = src;
    else if (src?._canvas instanceof HTMLCanvasElement) srcCanvas = src._canvas;
    else if (src?.pre instanceof HTMLCanvasElement) srcCanvas = src.pre;

    if (srcCanvas) {
      if (target.width !== srcCanvas.width)   target.width  = srcCanvas.width;
      if (target.height !== srcCanvas.height) target.height = srcCanvas.height;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, target.width, target.height);
      ctx.drawImage(srcCanvas, 0, 0, target.width, target.height);
    } else {
      ctx.clearRect(0, 0, target.width, target.height);
    }
    if (labelText) {
      ctx.font = "12px system-ui,-apple-system,Segoe UI,Roboto,Arial";
      const pad = 4, y = Math.max(12, target.height - 4);
      ctx.fillStyle = "rgba(0,0,0,.55)"; ctx.fillText(labelText, pad + 1, y + 1);
      ctx.fillStyle = "#e6e6e6";         ctx.fillText(labelText, pad, y);
    }
  }

  function showDebug(src, info) {
    _lastDbgSrc = src;
    if (info?.text) _lastDbgText = info.text;
    const dbg = getDebugCanvas();
    let srcCanvas = null;
    if (src instanceof HTMLCanvasElement) srcCanvas = src;
    else if (src?._canvas instanceof HTMLCanvasElement) srcCanvas = src._canvas;
    else if (src?.pre instanceof HTMLCanvasElement) srcCanvas = src.pre;
    else if (typeof OffscreenCanvas !== "undefined" && src instanceof OffscreenCanvas) srcCanvas = src;
    drawToCanvas(dbg, srcCanvas, info
      ? [info.text || "", typeof info.accuracy === "number" ? `acc: ${info.accuracy}%` : ""].filter(Boolean).join("  •  ")
      : null);
  }

  function setDebugAccuracy(pct) {
    _lastDbgAcc = typeof pct === "number" ? Math.max(0, Math.min(100, Math.round(pct))) : null;
    if (_lastDbgSrc) showDebug(_lastDbgSrc, { text: _lastDbgText, accuracy: _lastDbgAcc });
  }

  window.ScannerParts.debug = window.ScannerParts.debug || {};
  window.ScannerParts.debug.show = showDebug;
  window.showDebug = showDebug;

  // ── Frame capture ────────────────────────────────────────────────────────────
  function drawFrame() {
    const v = $("video");
    if (!v || !v.videoWidth) return null;
    const c = ensureWorkCanvas();
    c.width = v.videoWidth; c.height = v.videoHeight;
    const ctx = get2d(c);
    if (!ctx) return null;
    ctx.drawImage(v, 0, 0, c.width, c.height);
    return c;
  }

  function pause()  { paused = true; }
  function resume() { paused = false; stableMs = 0; lastVec = null; }

  // ── Safe module accessors ────────────────────────────────────────────────────
  const getNameOcr    = () => window.ScannerParts.ocr        || null;
  const getCodeSearch = () => window.LookupParts?.codeSearch || window.Lookup?.codeSearch || null;
  const getImageAssist= () => window.ScannerParts.imageAssist || window.ImageAssist || null;
  const getGeometry   = () => window.ScannerParts.geometry   || null;
  const getBand       = () => window.ScannerParts.band       || null;
  const getResolve    = () => window.LookupParts?.resolve    || null;

  // ── Dedup candidates by id+rarity ───────────────────────────────────────────
  function dedupCandidates(arr) {
    const seen = new Set();
    return arr.filter(c => {
      const k = `${c.id}|${c.set_rarity}|${c.set_code}`;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
  }

  // ── Promise with timeout (resolves to null on timeout, never rejects) ────────
  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise(resolve => setTimeout(() => resolve(null), ms)),
    ]);
  }

  // ── Wrap image-assist scoring — always resolves, never throws ────────────────
  async function runImageAssist(candidates, frame) {
    const ia = getImageAssist();
    if (!ia || typeof ia.scoreVisually !== "function" || !candidates.length) {
      return candidates.map(c => ({ ...c, imgScore: null, blendedScore: c.score || 0 }));
    }
    try {
      return await ia.scoreVisually(candidates, frame);
    } catch (e) {
      // CONSOLE-OFF v12 console.warn("[core] image assist failed:", e);
      return candidates.map(c => ({ ...c, imgScore: null, blendedScore: c.score || 0 }));
    }
  }

  // ── Resolve a name to candidates — never throws ───────────────────────────────
  async function resolveByName(nameText) {
    if (!nameText) {
      // CONSOLE-OFF v12 console.log("[core] name search skipped — empty OCR text");
      return [];
    }
    const resolve = getResolve();
    if (!resolve) {
      // CONSOLE-OFF v12 console.log("[core] name search skipped — resolve module not available");
      return [];
    }
    // CONSOLE-OFF v12 console.log("[core] DB name search attempt for:", nameText);
    try {
      const cands = await resolve.resolveTopCandidates(nameText, { topN: 5 });
      const arr = Array.isArray(cands) ? cands.map(c => ({ ...c, score: c.score || 0 })) : [];
      // CONSOLE-OFF v12 console.log(
        // CONSOLE-OFF v12 "[core] DB name search result for %o → %d candidate(s)%s",
        // CONSOLE-OFF v12 nameText, arr.length,
        // CONSOLE-OFF v12 arr.length ? " — top: " + arr.slice(0, 3).map(c => `${c.name} (${Math.round((c.score||0)*100)}%)`).join(" | ") : ""
      // CONSOLE-OFF v12 );
      return arr;
    } catch (e) {
      // CONSOLE-OFF v12 console.warn("[core] name resolve failed:", e);
      return [];
    }
  }

  // ── Core scan (name-only) ───────────────────────────────────────────────────
  //
  // The automatic scanner is name-only: detect the title band, OCR the name,
  // resolve candidates from the local DB, image-assist rank them, and fire once.
  // The set-code OCR pipeline was removed (issue #54) — manual code entry lives
  // in the UI layer (js/ui/lookup.js + js/ui/scan.js → codeSearch.resolveCode).
  //
  // The fire payload always uses scanMode "name" (or "none" when no candidates).
  // codes/codeOcrRaw are kept as empty constants so downstream UI stays safe.
  async function performScan(frame, onFound) {
    let fired = false;
    const t0 = Date.now();

    // Safe single-fire wrapper
    function fire(payload) {
      if (fired) return;
      fired = true;
      const elapsed = Date.now() - t0;
      // CONSOLE-OFF v12 console.log("[core] fire — scanMode:", payload.scanMode, "elapsed:", elapsed + "ms");
      onFound && onFound(payload);
    }

    const nameOcr = getNameOcr();
    const geo     = getGeometry();

    let nameResult     = null;
    let nameCandidates = [];
    let nameBand       = null;

    if (nameOcr && geo) {
      const band = geo.findTitleBand(frame);
      _lastDetectedRect = band?._rect || null;
      nameBand = band;
      if (band && !band._tooEmpty) {
        nameResult = await nameOcr.scanBand(band).catch(e => {
          // CONSOLE-OFF v12 console.warn("[core] name OCR failed:", e);
          return null;
        });
        if (nameResult || nameBand) {
          showDebug(nameResult || nameBand, { text: nameResult?.text || "(no name)" });
        }
        nameCandidates = await resolveByName(nameResult?.text || "");
      }
    }

    const merged = dedupCandidates(nameCandidates || [])
      .filter(c => (c.score || 0) >= ACCEPTABLE_SCORE);

    if (merged.length === 0) {
      fire({
        text: nameResult?.text || "", pre: nameResult?.pre || null,
        conf: nameResult?.conf || 0, raw: nameResult?.raw || "",
        codes: [], candidates: [], scanMode: nameResult?.text ? "name" : "none",
        codeOcrRaw: "",
      });
      return;
    }

    const scored = await withTimeout(runImageAssist(merged, frame), IMAGE_ASSIST_TIMEOUT_MS)
      ?? merged.map(c => ({ ...c, imgScore: null, blendedScore: c.score || 0 }));

    scored.sort((a, b) => (b.blendedScore || 0) - (a.blendedScore || 0));

    fire({
      text: nameResult?.text || "", pre: nameResult?.pre || null,
      conf: nameResult?.conf || 0, raw: nameResult?.raw || "",
      codes: [], candidates: scored, scanMode: "name",
      codeOcrRaw: "",
    });
  }

  // ── Monitoring loop ──────────────────────────────────────────────────────────
  function startMonitor(onFound, onState) {
    if (monitorTimer) clearInterval(monitorTimer);
    paused = false; cooldown = false; stableMs = 0; lastVec = null;

    // Pre-warm set list cache
    try {
      const cs = getCodeSearch();
      if (cs && typeof cs.fetchSetsList === "function") cs.fetchSetsList().catch(() => {});
    } catch (_) {}

    monitorTimer = setInterval(async () => {
      if (!window.stream) return;

      window.ScannerParts.overlay?.syncOverlaySize?.();

      if (paused) {
        window.ScannerParts.overlay?.drawOverlay?.("paused", _lastDetectedRect);
        onState && onState("paused", 0, {});
        return;
      }

      const frame = drawFrame();
      if (!frame) return;

      const geo  = getGeometry();
      const band = geo ? geo.findTitleBand(frame) : null;
      const rect = band?._rect || null;
      _lastDetectedRect = rect;

      if (band?._tooEmpty) {
        onState && onState("lowlight", 0, { rect, note: "empty-band" });
        window.ScannerParts.overlay?.drawOverlay?.("lowlight", rect, 0);
        stableMs = 0;
        showDebug(band, { text: "(no OCR — low contrast)" });
        return;
      }

      const bdLib = getBand();
      let state = "search";
      if (band && bdLib) {
        const vec      = bdLib.grayscaleVector(band);
        const delta    = bdLib.meanAbsDiff(vec, lastVec);
        lastVec        = vec;
        const contrast = bdLib.contrastEstimate(vec);
        if      (delta    > MOVEMENT_THRESHOLD) { stableMs = 0; state = "moving"; }
        else if (contrast < MIN_CONTRAST)       { stableMs = 0; state = "lowlight"; }
        else {
          stableMs += SAMPLE_INTERVAL_MS;
          state = stableMs >= STABLE_WINDOW_MS ? "scanning" : "steady";
        }
      } else {
        stableMs += SAMPLE_INTERVAL_MS;
        state = stableMs >= STABLE_WINDOW_MS ? "scanning" : "steady";
      }

      onState && onState(state, stableMs, { rect });
      window.ScannerParts.overlay?.drawOverlay?.(state, rect, stableMs);

      if (state === "scanning" && !cooldown) {
        cooldown = true;
        try {
          await performScan(frame, onFound);
          stableMs = 0; lastVec = null;
        } finally {
          setTimeout(() => { cooldown = false; }, 800);
        }
      }
    }, SAMPLE_INTERVAL_MS);
  }

  // ── Public Scanner facade ────────────────────────────────────────────────────
  window.Scanner = {
    start:        () => window.ScannerParts.camera.start(),
    stop: () => {
      if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
      window.ScannerParts.ocr?.terminateWorker?.();
      return window.ScannerParts.camera.stop();
    },
    startMonitor,
    pause,
    resume,
    setDebugAccuracy,
  };
})();
