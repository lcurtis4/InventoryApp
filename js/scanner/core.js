// js/scanner/core.js  — v11.1
//
// v11.1: when the name race wins, abort the remaining code-OCR passes via a
//        shared abortFlag {aborted:bool}. Before v11.1 the prompt appeared
//        on first confident hit, but the code OCR loop kept grinding through
//        all remaining preprocessing passes in the background — the user
//        could see the set-code debug canvas continue updating after the
//        confirm modal opened. The flag is now passed into scanCodeRegion()
//        and checked between regions AND inside _scanOneCrop's pass loop.
//
// v11: RACE name OCR vs code OCR — prompt user on first confident signal.
//      Before v11, performScan() did:
//        await codeOcrJob;            // ← blocks for all code OCR passes
//        if (exactCodeCands) fire("code")
//        else await nameOcrJob;       // ← only THEN looks at name
//      Symptom: when code OCR runs 11 passes and finds nothing, the user
//      waits the entire code loop (~3-7s) before the name confirm prompt
//      appears — even when the name resolved 1s in.
//      Fix: kick off both jobs at t=0 and watch them in parallel. Whichever
//      yields a CONFIDENT result first fires immediately:
//        • Code OCR confident = at least one exactMatch candidate.
//        • Name OCR confident = single candidate with score >= HIGH_NAME_SCORE
//                                (existing early-exit threshold).
//      If one side returns non-confident (or empty), we wait for the other
//      and use whatever combined evidence we have, falling back to the
//      merge+image-assist path the old code used.
//      The remaining code OCR regions still finish in the background but
//      cannot fire onFound twice — the single-fire guard ensures the user
//      sees only the first winner.
//
// v8.3 changes:
//   • New showCodePre() debug helper renders the preprocessed code-crop canvas
//     (the actual binarized image Tesseract sees) into #codeDebugCanvas with a
//     full live label: OCR raw text, extracted code, accuracy, pass label, and
//     (when applicable) the DB-confirmed card name. Exposed as
//     window.ScannerParts.debug.showCodePre and called from codeOcr.js on every
//     preprocessing pass — mirrors the name-band per-pass feedback.
//   • performScan() now consumes the pre-resolved dbCandidates returned by
//     scanCodeRegion (added in v8.3) instead of re-resolving from scratch when
//     codeOcr.js has already confirmed a DB hit. Falls back to the old
//     resolveByCodes() path if codeOcr.js didn't get a chance to look up.
//   • Added console logs to the name resolve path so every name-search attempt
//     is visible alongside the code-search logs.
//
// PARALLEL DETECTION WITH EARLY-EXIT (v8.2 behaviour, retained)
// ─────────────────────────────────────────────────────────
// All three detection paths fire simultaneously on each stable frame:
//   Job A — Code OCR  → set-code string → DB resolve → candidate list
//   Job B — Name OCR  → card name string → fuzzy resolve → candidate list
//   Job C — Image assist → visual re-ranking (runs on whichever candidates
//            arrive first from A or B; does not block early-exit)
//
// Early-exit rule (trust thresholds):
//   • Exact code match (exactMatch flag, score 1.0) → fire immediately,
//     do NOT wait for name or image. Highest trust.
//   • Name OCR with a single very-high-confidence result (score ≥ 0.90) →
//     fire immediately if code job is still pending or returned nothing.
//   • If code resolves with multiple candidates: wait for image assist
//     to re-rank (max IMAGE_ASSIST_TIMEOUT_MS), then fire.
//   • If both code and name return results: code exact-match wins outright;
//     otherwise merge+re-rank by blended score.
//   • If nothing is high-confidence after all jobs finish: fire with best
//     available, letting the UI show the candidate picker as before.
//
// "Fire" means calling onFound() exactly once per performScan() call.
// The scan loop's cooldown still prevents overlapping scans.
//
// Conservative constraint: image assist is always non-blocking for early-exit.
// If image assist finishes within IMAGE_ASSIST_TIMEOUT_MS it improves ranking;
// if it takes longer it is skipped for this frame (result still fires on time).
//
// No changes to: sheetsClient, confirm, lookup, scan UI flow, or any other file.

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

  // Trust thresholds for early-exit
  const EXACT_CODE_SCORE   = 1.0;   // exact code match — always fires immediately
  const HIGH_NAME_SCORE    = 0.90;  // single high-confidence name match — fires immediately
  const ACCEPTABLE_SCORE   = 0.65;  // minimum to include a candidate at all

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

  // ── Code-crop debug canvas (#codeDebugCanvas) — v8.2 ───────────────────────
  function getCodeDebugCanvas() {
    let c = $("codeDebugCanvas");
    if (!c) {
      const section = $("codeDebugSection") || $("video")?.parentElement || document.body;
      c = document.createElement("canvas");
      c.id = "codeDebugCanvas";
      c.style.cssText = "width:100%;height:80px;display:block;background:#1a1a1a;border-radius:8px;margin-top:4px;";
      section.appendChild(c);
    }
    return c;
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

  // ── Code-crop debug + low-light hint ────────────────────────────────────────
  function showCodeDebug(codeResult) {
    if (!codeResult) return;
    const codeDbg = getCodeDebugCanvas();
    let label = "";
    if (codeResult.codes?.length) label = `Code: ${codeResult.codes.join(", ")}`;
    else if (codeResult.raw)      label = `OCR: "${codeResult.raw}" (no match)`;
    else                          label = "No text read";
    if (typeof codeResult.brightness === "number") {
      label += `  [B:${codeResult.brightness} C:${codeResult.contrast}]`;
    }
    drawToCanvas(codeDbg, codeResult.cropCanvas || null, label);

    const hint = $("codeDebugHint");
    if (hint) {
      if (codeResult.lowLightWarning) {
        hint.textContent = `dim (B:${codeResult.brightness}, C:${codeResult.contrast}) — try better lighting`;
        hint.className   = "debug-hint debug-hint--warn";
      } else {
        hint.textContent = `B:${codeResult.brightness} C:${codeResult.contrast}`;
        hint.className   = "debug-hint debug-hint--ok";
      }
      hint.style.display = "";
    }
  }

  // Per-pass debug render (v8.3) — called from codeOcr.js after every Tesseract pass.
  // Mirrors showDebug() for the name band: renders the preprocessed canvas plus a
  // rich label (raw OCR text, extracted code, accuracy, pass label, DB-confirmed
  // card name) into #codeDebugCanvas so the Set code panel has the same live
  // per-pass feedback the Name band already provides.
  function showCodePre(preCanvas, info) {
    const codeDbg = getCodeDebugCanvas();
    const parts = [];
    if (info?.dbHit && info?.dbCode) {
      parts.push(`DB: ${info.dbCode} → ${info.dbHit}`);
    } else if (info?.codes && info.codes.length) {
      parts.push(`Code: ${info.codes.join(", ")}`);
    } else if (info?.raw) {
      parts.push(`OCR: "${info.raw}"`);
    } else {
      parts.push("(no text)");
    }
    if (info?.passLabel) parts.push(info.passLabel);
    if (typeof info?.accuracy === "number") parts.push(`acc: ${info.accuracy}%`);
    if (typeof info?.brightness === "number") parts.push(`B:${info.brightness} C:${info.contrast}`);
    drawToCanvas(codeDbg, preCanvas || null, parts.filter(Boolean).join("  •  "));

    const hint = $("codeDebugHint");
    if (hint && typeof info?.brightness === "number") {
      const dim = info.brightness < 55 || info.contrast < 12;
      if (dim) {
        hint.textContent = `dim (B:${info.brightness}, C:${info.contrast}) — try better lighting`;
        hint.className   = "debug-hint debug-hint--warn";
      } else {
        hint.textContent = `B:${info.brightness} C:${info.contrast}`;
        hint.className   = "debug-hint debug-hint--ok";
      }
      hint.style.display = "";
    }
  }

  window.ScannerParts.debug = window.ScannerParts.debug || {};
  window.ScannerParts.debug.show        = showDebug;
  window.ScannerParts.debug.showCode    = showCodeDebug;
  window.ScannerParts.debug.showCodePre = showCodePre;   // v8.3
  window.showDebug     = showDebug;
  window.showCodeDebug = showCodeDebug;

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
  const getCodeOcr    = () => window.ScannerParts.codeOcr    || null;
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

  // ── Resolve codes to candidates — never throws ────────────────────────────────
  async function resolveByCodes(codes) {
    if (!codes.length) {
      // CONSOLE-OFF v12 console.log("[core] code search skipped — no codes to resolve");
      return [];
    }
    const cs = getCodeSearch();
    if (!cs) {
      // CONSOLE-OFF v12 console.log("[core] code search skipped — codeSearch module not available");
      return [];
    }
    // CONSOLE-OFF v12 console.log("[core] DB code search attempt for codes:", codes);
    try {
      const results = await Promise.all(codes.map(c => cs.resolveCode(c).catch(() => null)));
      const out = [];
      for (const res of results) {
        if (!res?.candidates?.length) continue;
        for (const cand of res.candidates) {
          out.push({ ...cand, score: 1.0, matchedCode: res.code });
        }
      }
      // CONSOLE-OFF v12 console.log(
        // CONSOLE-OFF v12 "[core] DB code search result for %o → %d candidate(s) merged",
        // CONSOLE-OFF v12 codes, out.length
      // CONSOLE-OFF v12 );
      return out;
    } catch (e) {
      // CONSOLE-OFF v12 console.warn("[core] code resolve failed:", e);
      return [];
    }
  }

  // ── Core parallel scan ────────────────────────────────────────────────────────
  //
  // Strategy:
  //   1. Fire code OCR and name OCR simultaneously.
  //   2. As soon as code OCR resolves: if it yields an exact match, call onFound
  //      immediately with scanMode="code" and a background image-assist task
  //      that will NOT delay the UI (image assist result is silently discarded if
  //      it arrives after onFound has already fired).
  //   3. If code OCR yields no exact match, wait for name OCR too, merge
  //      candidates, then run image assist (with timeout), then call onFound once.
  //   4. onFound is called exactly once per performScan() invocation.
  //
  async function performScan(frame, onFound) {
    let fired = false;
    const t0 = Date.now();

    // Safe single-fire wrapper
    function fire(payload) {
      if (fired) return;
      fired = true;
      const elapsed = Date.now() - t0;
      // CONSOLE-OFF v12 console.log("[core] v11 RACE fire — scanMode:", payload.scanMode, "elapsed:", elapsed + "ms");
      onFound && onFound(payload);
    }

    const codeOcr = getCodeOcr();
    const nameOcr = getNameOcr();
    const geo     = getGeometry();

    // ── Shared race state ────────────────────────────────────────────────────
    // undefined = still running; null = finished with no result; array = done.
    let codeResult       = undefined;
    let codeCandidates   = undefined;
    let nameResult       = undefined;
    let nameCandidates   = undefined;
    let nameBand         = null;

    // v11.1: shared abort flag. When name OCR wins, we flip this so the
    // remaining code-OCR preprocessing passes and regions stop immediately
    // instead of grinding through and updating the set-code debug canvas.
    const codeAbort = { aborted: false };

    // ── Helper: fire on confident code win (exactMatch present) ──────────────
    function tryFireCodeWin() {
      if (fired) return false;
      if (!Array.isArray(codeCandidates)) return false;
      const exact = codeCandidates.filter(c => c.exactMatch);
      if (exact.length === 0) return false;

      // CONSOLE-OFF v12 console.log("[core] v11 RACE — code WIN (" + exact.length + " exact candidate(s))");
      const earlyDeduped = dedupCandidates(exact);

      // Non-blocking image assist for ranking
      withTimeout(runImageAssist(earlyDeduped, frame), IMAGE_ASSIST_TIMEOUT_MS)
        .then(scored => {
          if (!fired && scored) {
            scored.sort((a, b) => (b.blendedScore || 0) - (a.blendedScore || 0));
            fire({
              text: "", pre: null, conf: 0, raw: codeResult?.raw || "",
              codes: codeResult?.codes || [], candidates: scored, scanMode: "code",
              codeOcrRaw: codeResult?.raw || "",
              lowLightWarning: codeResult?.lowLightWarning || false,
              brightness: codeResult?.brightness, contrast: codeResult?.contrast,
            });
          }
        })
        .catch(() => {});

      // Timeout fallback — fire without image assist if it takes too long
      setTimeout(() => {
        if (!fired) {
          const fallback = earlyDeduped.map(c => ({ ...c, imgScore: null, blendedScore: 1.0 }));
          fire({
            text: "", pre: null, conf: 0, raw: codeResult?.raw || "",
            codes: codeResult?.codes || [], candidates: fallback, scanMode: "code",
            codeOcrRaw: codeResult?.raw || "",
            lowLightWarning: codeResult?.lowLightWarning || false,
            brightness: codeResult?.brightness, contrast: codeResult?.contrast,
          });
        }
      }, IMAGE_ASSIST_TIMEOUT_MS);

      return true;
    }

    // ── Helper: fire on confident name win (single high-score candidate) ─────
    function tryFireNameWin() {
      if (fired) return false;
      if (!Array.isArray(nameCandidates)) return false;
      if (nameCandidates.length !== 1) return false;
      if ((nameCandidates[0].score || 0) < HIGH_NAME_SCORE) return false;

      // CONSOLE-OFF v12 console.log("[core] v11 RACE — name WIN (score=" + (nameCandidates[0].score || 0).toFixed(3) + ") — aborting code OCR");
      codeAbort.aborted = true;
      const best = nameCandidates[0];

      withTimeout(runImageAssist([best], frame), IMAGE_ASSIST_TIMEOUT_MS)
        .then(scored => {
          if (!fired && scored) {
            fire({
              text: nameResult?.text || "", pre: nameResult?.pre || null,
              conf: nameResult?.conf || 0, raw: nameResult?.raw || "",
              codes: [], candidates: scored, scanMode: "name",
              codeOcrRaw: codeResult?.raw || "",
              lowLightWarning: codeResult?.lowLightWarning || false,
              brightness: codeResult?.brightness, contrast: codeResult?.contrast,
            });
          }
        })
        .catch(() => {});

      setTimeout(() => {
        if (!fired) {
          fire({
            text: nameResult?.text || "", pre: nameResult?.pre || null,
            conf: nameResult?.conf || 0, raw: nameResult?.raw || "",
            codes: [], candidates: [{ ...best, imgScore: null, blendedScore: best.score || 0 }],
            scanMode: "name",
            codeOcrRaw: codeResult?.raw || "",
            lowLightWarning: codeResult?.lowLightWarning || false,
            brightness: codeResult?.brightness, contrast: codeResult?.contrast,
          });
        }
      }, IMAGE_ASSIST_TIMEOUT_MS);

      return true;
    }

    // ── Launch code OCR job ──────────────────────────────────────────────────
    const codeJob = codeOcr ? (async () => {
      const result = await codeOcr.scanCodeRegion(frame, codeAbort).catch(e => {
        // CONSOLE-OFF v12 console.warn("[core] code OCR failed:", e);
        return null;
      });
      codeResult = result;
      if (result) showCodeDebug(result);
      const codes = result?.codes || [];
      if (codes.length > 0) {
        const pre = Array.isArray(result?.dbCandidates) ? result.dbCandidates : [];
        if (pre.length > 0) {
          // CONSOLE-OFF v12 console.log(
            // CONSOLE-OFF v12 "[core] using %d pre-resolved candidate(s) from codeOcr.js per-pass DB lookup",
            // CONSOLE-OFF v12 pre.length
          // CONSOLE-OFF v12 );
          codeCandidates = pre.map(c => ({ ...c, score: 1.0, exactMatch: true }));
        } else {
          codeCandidates = await resolveByCodes(codes);
        }
      } else {
        codeCandidates = [];
      }
      tryFireCodeWin();
    })() : (async () => { codeResult = null; codeCandidates = []; })();

    // ── Launch name OCR job ──────────────────────────────────────────────────
    const nameJob = (nameOcr && geo) ? (async () => {
      const band = geo.findTitleBand(frame);
      _lastDetectedRect = band._rect;
      nameBand = band;
      if (band._tooEmpty) {
        nameResult = null;
        nameCandidates = [];
        return;
      }
      const result = await nameOcr.scanBand(band).catch(e => {
        // CONSOLE-OFF v12 console.warn("[core] name OCR failed:", e);
        return null;
      });
      nameResult = result;
      if (result || nameBand) {
        showDebug(result || nameBand, { text: result?.text || "(no name)" });
      }
      nameCandidates = await resolveByName(result?.text || "");
      tryFireNameWin();
    })() : (async () => { nameResult = null; nameCandidates = []; })();

    // ── Wait for both jobs to finish ─────────────────────────────────────────
    await Promise.all([codeJob, nameJob]);

    // If a winner already fired, we're done — the .then handlers and timeouts
    // above will deliver the payload.
    if (fired) return;

    // Re-check in case both finished simultaneously without firing in their
    // own callbacks (shouldn't happen, but defensive).
    if (tryFireCodeWin() || tryFireNameWin()) return;

    // ── Fallback: merge partial code + name candidates, image-assist, fire ───
    const codes = codeResult?.codes || [];
    const partialCodeCands = (codeCandidates || []).filter(c => !c.exactMatch).map(c => ({ ...c, score: 0.8 }));
    const merged = dedupCandidates([...partialCodeCands, ...(nameCandidates || [])])
      .filter(c => (c.score || 0) >= ACCEPTABLE_SCORE);

    if (merged.length === 0) {
      fire({
        text: nameResult?.text || "", pre: nameResult?.pre || null,
        conf: nameResult?.conf || 0, raw: nameResult?.raw || codeResult?.raw || "",
        codes, candidates: [], scanMode: codes.length ? "code" : (nameResult?.text ? "name" : "none"),
        codeOcrRaw: codeResult?.raw || "",
        lowLightWarning: codeResult?.lowLightWarning || false,
        brightness: codeResult?.brightness, contrast: codeResult?.contrast,
      });
      return;
    }

    const scanMode = codes.length > 0 ? "code" : "name";
    const scored = await withTimeout(runImageAssist(merged, frame), IMAGE_ASSIST_TIMEOUT_MS)
      ?? merged.map(c => ({ ...c, imgScore: null, blendedScore: c.score || 0 }));

    scored.sort((a, b) => (b.blendedScore || 0) - (a.blendedScore || 0));

    fire({
      text: nameResult?.text || "", pre: nameResult?.pre || null,
      conf: nameResult?.conf || 0, raw: nameResult?.raw || codeResult?.raw || "",
      codes, candidates: scored, scanMode,
      codeOcrRaw: codeResult?.raw || "",
      lowLightWarning: codeResult?.lowLightWarning || false,
      brightness: codeResult?.brightness, contrast: codeResult?.contrast,
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
      window.ScannerParts.codeOcr?.terminateCodeWorker?.();
      return window.ScannerParts.camera.stop();
    },
    startMonitor,
    pause,
    resume,
    setDebugAccuracy,
  };
})();
