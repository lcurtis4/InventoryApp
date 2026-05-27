// js/scanner/codeOcr.js  — v8.3d
// Changes vs v8.2:
//   • PER-PASS LIVE DEBUG RENDERING: matches the behaviour of ocr.js (name OCR).
//     The "Set code OCR crop" panel now updates on every preprocessing pass with
//     the actual preprocessed (binarized) image Tesseract sees, the raw OCR text,
//     extracted code, and accuracy — so the user has the same live feedback the
//     name band already provides.
//   • PER-PASS DB SEARCH: as soon as any pass extracts a valid code we hit the
//     code-search resolver (window.LookupParts.codeSearch.resolveCode) so the
//     database lookup happens immediately rather than only after every pass
//     finishes. The pass loop short-circuits on the first DB-confirmed hit.
//   • CONSOLE LOGGING: every code-OCR pass logs its raw text, extracted code,
//     accuracy, and (when applicable) the DB lookup attempt + outcome — useful
//     for diagnosing why a particular card isn't resolving.
// Changes vs v8.1 (carried forward from v8.2):
//   • Low-light preprocessing: added gamma correction, auto-contrast (CLAHE-lite),
//     and Otsu threshold computation.  The threshold-sweep now includes gamma-
//     brightened + auto-contrast variants so dim / poorly lit cards get better hits.
//   • cropCodeRegion() returns brightness/contrast diagnostics in _diagnostics.
//   • scanCodeRegion() result includes { brightness, contrast, lowLightWarning }.
//   • All new preprocessing helpers are pure pixel-array operations — no canvas
//     extra deps, fully browser-compatible (Chrome/Firefox/Safari/Edge).
//
// Pipeline:
//   1. cropCodeRegion()        — extract bottom-left strip; measure brightness+contrast
//   2. preprocessForCode()     — sharpen + binarize (existing)
//   3. preprocessGamma()       — gamma-brighten then binarize (new: low-light)
//   4. preprocessAutoContrast()— stretch histogram to [0,255] then binarize (new)
//   5. preprocessOtsu()        — compute optimal threshold automatically (new)
//   6. runCodeOcr()            — Tesseract; multi-pass across all preprocessing variants
//   7. extractCodes()          — regex scan + OCR-confusion normalization
//   8. scanCodeRegion()        — public entry; returns codes + diagnostics

(function () {
  "use strict";

  window.ScannerParts = window.ScannerParts || {};
  // CONSOLE-OFF v12 console.log("[codeOcr] module loaded — v8.3d (region fix: art-bottom-right between art and type bar)");

  // ── Crop tuning ──────────────────────────────────────────────────────────────
  // v12: removed the "bottom-left" (pendulum-position / older-prints) region.
  //      It scanned the strip above the copyright line on legacy prints (LOB,
  //      MRD, SDY…) but added noise + ~11 extra preprocessing passes per scan
  //      without paying for itself on this user's modern collection. The
  //      remaining region (renamed "set code" for clarity) covers the thin
  //      strip BETWEEN the bottom of the card artwork and the [TYPE/Effect]
  //      bar, right-aligned — where Konami prints set codes on every modern
  //      release (BLZD, MP25, OP29, DOOD, etc.).
  //
  // Coordinates are fractions of the detected card rect (NOT of the visible
  // video). y=0 is the top of the card, y=1 is the bottom.
  //   top:    y position of the top of the strip (fraction of card height)
  //   height: vertical size of the strip (fraction of card height)
  //   left:   x position of the left edge (fraction of card width)
  //   width:  horizontal size (fraction of card width)
  const CODE_REGIONS = [
    {
      name:   "set code", // modern: strip between art bottom and type bar, right-aligned
      top:    0.72,
      height: 0.07,
      left:   0.50,
      width:  0.49,
      minW:   60,
      minH:   10,
    },
  ];

  // Legacy single-region constant retained for any external callers; no longer
  // used internally by cropCodeRegion() / scanCodeRegion().
  const CODE_REGION = {
    fromBottomFrac: 0.485,
    heightFrac:     0.035,
    fromLeftFrac:   0.55,
    widthFrac:      0.44,
    minW: 60,
    minH: 10,
  };

  const CODE_SCALE = 3.5;

  // ── Preprocessing pass definitions ──────────────────────────────────────────
  // Each entry describes ONE preprocessing variant that will be tried in order.
  // The loop stops as soon as a pass yields at least one valid code match.
  // "kind" controls which preprocessing function to call.
  const CODE_PASSES = [
    // Standard binarize passes (original v8 set)
    { kind: "sharpen-binarize", inv: false, th: 160, sc: CODE_SCALE },
    { kind: "sharpen-binarize", inv: false, th: 140, sc: CODE_SCALE },
    { kind: "sharpen-binarize", inv: true,  th: 160, sc: CODE_SCALE },
    { kind: "sharpen-binarize", inv: false, th: 180, sc: CODE_SCALE },

    // Low-light: gamma-brightened (gamma < 1 → brightens mid-tones)
    // These help when the card is in a dim room or the code area is shadowed.
    { kind: "gamma", gamma: 0.5,  inv: false, th: 140, sc: CODE_SCALE },
    { kind: "gamma", gamma: 0.4,  inv: false, th: 120, sc: CODE_SCALE },
    { kind: "gamma", gamma: 0.5,  inv: true,  th: 140, sc: CODE_SCALE },

    // Low-light: auto-contrast stretch (maps darkest→0, brightest→255)
    // Helps when the camera under-exposes the crop.
    { kind: "auto-contrast", inv: false, th: 160, sc: CODE_SCALE },
    { kind: "auto-contrast", inv: true,  th: 160, sc: CODE_SCALE },

    // Otsu threshold (computed per-image; no fixed th needed)
    { kind: "otsu", inv: false, sc: CODE_SCALE },
    { kind: "otsu", inv: true,  sc: CODE_SCALE },
  ];

  // YGO set-code regex
  const CODE_REGEX = /\b([A-Z0-9]{2,6})[-_ |]([A-Z]{2})([0-9]{3,4})\b/g;

  // ── Safe context helper ───────────────────────────────────────────────────────
  const ctx2d = (c) => c && c.getContext && c.getContext("2d", { willReadFrequently: true });

  // ── OCR confusion normalization ───────────────────────────────────────────────
  function normalizeCodeSegment(seg, isNumeric) {
    let s = String(seg || "").toUpperCase();
    if (isNumeric) {
      s = s.replace(/O/g, "0").replace(/I/g, "1").replace(/S/g, "5");
    } else {
      s = s.replace(/[^A-Z0-9]/g, "");
    }
    return s;
  }

  // ── Extract codes from raw OCR text ─────────────────────────────────────────
  function extractCodes(raw) {
    if (!raw) return [];
    let text = raw.toUpperCase();
    text = text.replace(/[_|–—]/g, "-");
    text = text.replace(/([A-Z0-9]{2,6})\s*-\s*([A-Z]{2})\s*([0-9]{3,4})/g, "$1-$2$3");

    const codes = new Set();
    let match;
    const re = new RegExp(CODE_REGEX.source, "g");
    while ((match = re.exec(text)) !== null) {
      const prefix = normalizeCodeSegment(match[1], false);
      const region = normalizeCodeSegment(match[2], false);
      const num    = normalizeCodeSegment(match[3], true);
      if (prefix.length >= 2 && region.length === 2 && num.length >= 3) {
        codes.add(`${prefix}-${region}${num.slice(0, 3)}`);
      }
    }
    return [...codes];
  }

  // ── Pixel-level helpers ───────────────────────────────────────────────────────

  // Compute per-pixel luminance array (Y, 0–255) from ImageData
  function toLuminance(imgData) {
    const d = imgData.data;
    const n = imgData.width * imgData.height;
    const Y = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      Y[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
    }
    return Y;
  }

  // Measure brightness (mean) and RMS contrast of a luminance array
  function measureBrightnessContrast(Y) {
    if (!Y || Y.length === 0) return { brightness: 128, contrast: 0 };
    let sum = 0;
    for (let i = 0; i < Y.length; i++) sum += Y[i];
    const mean = sum / Y.length;
    let variance = 0;
    for (let i = 0; i < Y.length; i++) variance += (Y[i] - mean) ** 2;
    const rms = Math.sqrt(variance / Y.length);
    return { brightness: mean, contrast: rms };
  }

  // Compute Otsu threshold from a luminance array (fast histogram method)
  function otsuThreshold(Y) {
    const hist = new Int32Array(256);
    for (let i = 0; i < Y.length; i++) hist[Math.round(Y[i]) | 0]++;
    const total = Y.length;
    let sum = 0;
    for (let t = 0; t < 256; t++) sum += t * hist[t];

    let sumB = 0, wB = 0, wF = 0;
    let maxVar = 0, threshold = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      wF = total - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const interVar = wB * wF * (mB - mF) ** 2;
      if (interVar > maxVar) { maxVar = interVar; threshold = t; }
    }
    return threshold;
  }

  // Apply gamma correction to ImageData (in-place)
  function applyGamma(imageData, gamma) {
    const d = imageData.data;
    // Pre-build LUT for speed
    const lut = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      lut[i] = Math.round(255 * Math.pow(i / 255, gamma));
    }
    for (let i = 0; i < d.length; i += 4) {
      d[i]     = lut[d[i]];
      d[i + 1] = lut[d[i + 1]];
      d[i + 2] = lut[d[i + 2]];
    }
    return imageData;
  }

  // Apply linear contrast stretch (min→0, max→255) to ImageData (in-place)
  function applyAutoContrast(imageData) {
    const d = imageData.data;
    let lo = 255, hi = 0;
    for (let i = 0; i < d.length; i += 4) {
      const v = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const range = hi - lo || 1;
    const scale = 255 / range;
    for (let i = 0; i < d.length; i += 4) {
      d[i]     = Math.round((d[i]     - lo) * scale);
      d[i + 1] = Math.round((d[i + 1] - lo) * scale);
      d[i + 2] = Math.round((d[i + 2] - lo) * scale);
    }
    return imageData;
  }

  // ── Preprocessing pipeline entry ─────────────────────────────────────────────
  // Returns a binarized canvas ready for Tesseract.
  function preprocessForCode(src, pass) {
    const Pre = window.ScannerParts.preprocess || {};
    const scale = pass.sc || CODE_SCALE;

    // Step 1: upscale
    const up = document.createElement("canvas");
    up.width  = Math.max(1, Math.floor(src.width  * scale));
    up.height = Math.max(1, Math.floor(src.height * scale));
    const uc = ctx2d(up);
    uc.imageSmoothingEnabled = true;
    uc.drawImage(src, 0, 0, up.width, up.height);

    if (pass.kind === "sharpen-binarize") {
      // Delegate to preprocess.js (original pipeline — sharpen + fixed threshold)
      if (typeof Pre.upscaleSharpenAndBinarize === "function") {
        return Pre.upscaleSharpenAndBinarize(src, scale, pass.th, pass.inv);
      }
      // Fallback: just return upscaled canvas
      return up;
    }

    // Step 2: get pixel data for manipulation
    let imgData = uc.getImageData(0, 0, up.width, up.height);

    if (pass.kind === "gamma") {
      applyGamma(imgData, pass.gamma || 0.5);
    } else if (pass.kind === "auto-contrast") {
      applyAutoContrast(imgData);
    }
    // For "otsu" — no luminance transform before threshold computation

    // Step 3: compute threshold
    const Y = toLuminance(imgData);
    let threshold;
    if (pass.kind === "otsu") {
      threshold = otsuThreshold(Y);
    } else {
      threshold = pass.th || 128;
    }

    // Step 4: binarize (in-place)
    const d = imgData.data;
    for (let i = 0; i < Y.length; i++) {
      const v = pass.inv ? (Y[i] < threshold ? 255 : 0) : (Y[i] > threshold ? 255 : 0);
      d[i * 4]     = v;
      d[i * 4 + 1] = v;
      d[i * 4 + 2] = v;
      d[i * 4 + 3] = 255;
    }

    // Step 5: sharpen (unsharp mask, same as preprocess.js)
    const blur  = new Uint8ClampedArray(d.length);
    const W = up.width, H = up.height;
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const idx = (y * W + x) * 4;
        let r = 0;
        for (let yy = -1; yy <= 1; yy++) {
          for (let xx = -1; xx <= 1; xx++) {
            r += d[((y + yy) * W + (x + xx)) * 4];
          }
        }
        blur[idx] = blur[idx + 1] = blur[idx + 2] = r / 9;
        blur[idx + 3] = 255;
      }
    }
    for (let i = 0; i < d.length; i += 4) {
      const sharpened = Math.max(0, Math.min(255,
        d[i] + (d[i] - blur[i]) * 0.6));
      // After binarize the pixel is already 0 or 255 — sharpen only emphasises edges
      d[i] = d[i + 1] = d[i + 2] = sharpened > 127 ? 255 : 0;
    }

    uc.putImageData(imgData, 0, 0);
    return up;
  }

  // ── Crop code region + measure image quality ──────────────────────────────────
  //
  // v8.3 FIX:  the v8.2 implementation tried to extrapolate the card bounds from
  // the visible-video width (`visSrcW`) and the card aspect ratio. That is wrong:
  // `visSrcW` is the entire visible-video width, not the width of the card the
  // user is holding. The derived `cardH = visSrcW / 0.686` was ~1.46× the visible
  // width, which pushed the resulting set-code crop completely OFF-SCREEN (below
  // the bottom of the source frame). The clamping logic then collapsed the crop
  // to a 1-pixel-tall slice and the `w < minW || h < minH` guard returned null —
  // which is exactly what `[codeOcr] cropCodeRegion returned null` was reporting.
  //
  // The new implementation mirrors the SAME math `overlay.js` uses to draw the
  // dashed blue "Place card here" rectangle on screen, then maps that rectangle
  // back into source-video pixels using the standard object-fit: cover transform.
  // The set code is then cropped from the bottom-left of THAT rectangle — which
  // is exactly where the card actually sits on screen.
  // v8.3c: Compute the card-in-source rect from the on-screen overlay math.
  // Returns { cardX, cardY, cardW, cardH } in source-video pixels, or null if
  // the video element isn't ready yet.
  function _computeCardRectInSource() {
    const v = document.getElementById("video");
    if (!v || !v.videoWidth || !v.videoHeight) return null;

    const ow = v.clientWidth  || v.videoWidth;
    const oh = v.clientHeight || v.videoHeight;
    const sw = v.videoWidth;
    const sh = v.videoHeight;

    const scale      = Math.max(ow / sw, oh / sh);
    const visSrcW    = ow / scale;
    const visSrcH    = oh / scale;
    const srcOffsetX = (sw - visSrcW) / 2;
    const srcOffsetY = (sh - visSrcH) / 2;

    const CARD_ASPECT =
      (window.ScannerParts.CONST && window.ScannerParts.CONST.CARD_ASPECT_WH) ||
      (59 / 86);

    const cardH_vis = oh * 0.80;
    const cardW_vis = cardH_vis * CARD_ASPECT;
    const cardX_vis = (ow - cardW_vis) / 2;
    const cardY_vis = (oh - cardH_vis) / 2;

    return {
      cardX: srcOffsetX + cardX_vis / scale,
      cardY: srcOffsetY + cardY_vis / scale,
      cardW: cardW_vis / scale,
      cardH: cardH_vis / scale,
    };
  }

  // v8.3c: crop a SINGLE configured region. `region` is one of CODE_REGIONS.
  // Uses top/height/left/width fractions of the card rect (NOT the visible
  // video). Returns a canvas with _srcRect, _diagnostics, and _region set.
  function cropRegionFromCard(frameCanvas, region) {
    const rect = _computeCardRectInSource();
    if (!rect) {
      // CONSOLE-OFF v12 console.log("[codeOcr] cropRegionFromCard: no video / not ready");
      return null;
    }
    const { cardX, cardY, cardW, cardH } = rect;

    const cropX = Math.floor(cardX + cardW * region.left);
    const cropY = Math.floor(cardY + cardH * region.top);
    const cropW = Math.floor(cardW * region.width);
    const cropH = Math.floor(cardH * region.height);

    const W = frameCanvas.width;
    const H = frameCanvas.height;
    const x = Math.max(0, Math.min(W - 1, cropX));
    const y = Math.max(0, Math.min(H - 1, cropY));
    const w = Math.max(1, Math.min(W - x, cropW));
    const h = Math.max(1, Math.min(H - y, cropH));

    if (w < region.minW || h < region.minH) {
      // CONSOLE-OFF v12 console.log(
        // CONSOLE-OFF v12 "[codeOcr] cropRegionFromCard(%s): too small after clamp (w=%d h=%d  raw cropX=%d cropY=%d cropW=%d cropH=%d  frame=%dx%d)",
        // CONSOLE-OFF v12 region.name, w, h, cropX, cropY, cropW, cropH, W, H
      // CONSOLE-OFF v12 );
      return null;
    }

    const out = document.createElement("canvas");
    out.width  = w;
    out.height = h;
    const oc = ctx2d(out);
    oc.drawImage(frameCanvas, x, y, w, h, 0, 0, w, h);
    out._srcRect = { x, y, w, h };
    out._region  = region.name;

    const imgData = oc.getImageData(0, 0, w, h);
    const Y = toLuminance(imgData);
    const { brightness, contrast } = measureBrightnessContrast(Y);
    out._diagnostics = { brightness: Math.round(brightness), contrast: Math.round(contrast) };

    return out;
  }

  // Legacy single-region helper retained for backward compatibility. Now
  // returns the art-bottom-right crop (the primary location for modern prints).
  function cropCodeRegion(frameCanvas) {
    return cropRegionFromCard(frameCanvas, CODE_REGIONS[0]);
  }

  // ── Persistent Tesseract worker ───────────────────────────────────────────────
  let _codeWorker      = null;
  let _codeWorkerReady = false;
  let _codeWorkerProm  = null;

  async function getCodeWorker() {
    if (_codeWorkerReady && _codeWorker) return _codeWorker;
    if (_codeWorkerProm) return _codeWorkerProm;
    _codeWorkerProm = (async () => {
      _codeWorker = await Tesseract.createWorker("eng", 1, { logger: () => {} });
      _codeWorkerReady = true;
      return _codeWorker;
    })();
    try {
      return await _codeWorkerProm;
    } catch (err) {
      _codeWorker = null;
      _codeWorkerReady = false;
      _codeWorkerProm  = null;
      throw err;
    }
  }

  async function terminateCodeWorker() {
    _codeWorkerReady = false;
    _codeWorkerProm  = null;
    if (_codeWorker) {
      try { await _codeWorker.terminate(); } catch (_) {}
      _codeWorker = null;
    }
  }

  const CODE_TESS_PARAMS = {
    tessedit_pageseg_mode: "7",
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-",
  };

  // Low-light warning thresholds
  const LOW_BRIGHTNESS_THRESHOLD = 55;   // mean pixel luminance out of 255
  const LOW_CONTRAST_THRESHOLD   = 12;   // RMS contrast out of 255

  // ── Safe per-pass debug hook (v8.3) ──────────────────────────────────────────
  // Mirrors dbgShow() in ocr.js: renders the preprocessed canvas plus a label
  // (raw OCR text + extracted code + accuracy) into the #codeDebugCanvas after
  // every Tesseract pass, so the user sees the same kind of live feedback the
  // name band already provides.
  function dbgShowCodePre(preCanvas, info) {
    try {
      const fn =
        (window.ScannerParts.debug && window.ScannerParts.debug.showCodePre) ||
        (window.ScannerParts.debug && window.ScannerParts.debug.showCode) ||
        window.showCodeDebug;
      if (typeof fn === "function") fn(preCanvas, info || {});
    } catch (_) { /* never let debug break OCR */ }
  }

  // Safe accessor for the code-search resolver (per-pass DB lookup).
  function getCodeSearch() {
    return (window.LookupParts && window.LookupParts.codeSearch) ||
           (window.Lookup      && window.Lookup.codeSearch)      || null;
  }

  // v8.3c: per-crop scan helper. Runs every CODE_PASS against a single crop,
  // updates the debug overlay live, attempts a DB lookup on each extracted
  // code, and short-circuits on the first DB-confirmed match. Returns the
  // same shape as scanCodeRegion did pre-v8.3c.
  async function _scanOneCrop(crop, worker, regionLabel, abortFlag) {
    const diag = crop._diagnostics || { brightness: 128, contrast: 20 };
    const lowLightWarning = diag.brightness < LOW_BRIGHTNESS_THRESHOLD
                         || diag.contrast   < LOW_CONTRAST_THRESHOLD;

    // CONSOLE-OFF v12 console.log(
      // CONSOLE-OFF v12 "[codeOcr] scan region '%s' — crop %dx%d  brightness=%d  contrast=%d  lowLight=%s",
      // CONSOLE-OFF v12 regionLabel, crop.width, crop.height, diag.brightness, diag.contrast, lowLightWarning
    // CONSOLE-OFF v12 );

    let allCodes     = [];
    let bestRaw      = "";
    let dbCandidates = [];
    let firstMatchedCode = null;

    for (let pi = 0; pi < CODE_PASSES.length; pi++) {
      // v11.1: bail immediately if a peer OCR path (name) has already fired.
      if (abortFlag && abortFlag.aborted) {
        // CONSOLE-OFF v12 console.log("[codeOcr] [%s] aborted before pass %d/%d (name OCR already won)", regionLabel, pi + 1, CODE_PASSES.length);
        break;
      }
      const pass = CODE_PASSES[pi];
      const pre  = preprocessForCode(crop, pass);

      // Build a short pass label for logs + debug overlay
      const passLabel = pass.kind === "sharpen-binarize"
        ? `sb th=${pass.th}${pass.inv ? " inv" : ""}`
        : pass.kind === "gamma"
          ? `gamma=${pass.gamma} th=${pass.th}${pass.inv ? " inv" : ""}`
          : pass.kind === "auto-contrast"
            ? `auto-c th=${pass.th}${pass.inv ? " inv" : ""}`
            : `otsu${pass.inv ? " inv" : ""}`;

      try {
        const { data } = await worker.recognize(pre, CODE_TESS_PARAMS);
        const raw   = String(data?.text || "").replace(/\s+/g, " ").trim();
        const codes = extractCodes(raw);
        const conf  = typeof data?.confidence === "number"
          ? Math.max(0, Math.min(100, Math.round(data.confidence)))
          : 0;

        // CONSOLE-OFF v12 console.log(
          // CONSOLE-OFF v12 "[codeOcr] [%s] pass %d/%d (%s) → raw=%o  codes=%o  acc=%d%%",
          // CONSOLE-OFF v12 regionLabel, pi + 1, CODE_PASSES.length, passLabel, raw, codes, conf
        // CONSOLE-OFF v12 );

        // Live debug render — mirrors the name band per-pass behaviour
        dbgShowCodePre(pre, {
          raw,
          codes,
          accuracy: conf,
          passLabel: regionLabel + " | " + passLabel,
          brightness: diag.brightness,
          contrast:   diag.contrast,
        });

        if (codes.length > 0) {
          if (!bestRaw) bestRaw = raw;
          for (const c of codes) allCodes.push(c);

          // ── PER-PASS DB SEARCH (v8.3) ─────────────────────────────────────
          // As soon as a pass extracts a valid code, attempt to resolve it
          // against the YGOPRODeck DB. If we get an exact-match candidate,
          // we short-circuit the remaining passes — same idea as the name
          // OCR "first useful result wins" pattern.
          const cs = getCodeSearch();
          if (cs && typeof cs.resolveCode === "function") {
            for (const code of codes) {
              // CONSOLE-OFF v12 console.log("[codeOcr] DB lookup attempt for code:", code);
              let res = null;
              try {
                res = await cs.resolveCode(code);
              } catch (e) {
                // CONSOLE-OFF v12 console.warn("[codeOcr] DB lookup threw for", code, e);
              }
              const cands = res?.candidates || [];
              // CONSOLE-OFF v12 console.log(
                // CONSOLE-OFF v12 "[codeOcr] DB lookup result for %s → status=%s  candidates=%d",
                // CONSOLE-OFF v12 code, res?.status || "error", cands.length
              // CONSOLE-OFF v12 );

              if (cands.length > 0) {
                dbCandidates    = cands.map(c => ({ ...c, matchedCode: code }));
                firstMatchedCode = code;
                // Update the debug overlay with the DB-confirmed name so the
                // user sees the match in the same panel.
                dbgShowCodePre(pre, {
                  raw,
                  codes,
                  accuracy: conf,
                  passLabel: regionLabel + " | " + passLabel,
                  brightness: diag.brightness,
                  contrast:   diag.contrast,
                  dbHit:      cands[0].name,
                  dbCode:     code,
                });
                break;
              }
            }
          } else {
            // CONSOLE-OFF v12 console.log("[codeOcr] code-search module not available yet — skipping DB lookup this pass");
          }

          // Early exit on first hit (standard lighting passes only — keeps latency low)
          if (pass.kind === "sharpen-binarize") break;
        } else if (!bestRaw && raw) {
          bestRaw = raw;
        }
      } catch (e) {
        // CONSOLE-OFF v12 console.warn("[codeOcr] recognize pass failed:", passLabel, e);
        dbgShowCodePre(pre, { raw: "(recognize error)", codes: [], accuracy: 0, passLabel });
      }

      // If we got a DB-confirmed match, stop scanning further passes entirely.
      if (dbCandidates.length > 0) {
        // CONSOLE-OFF v12 console.log(
          // CONSOLE-OFF v12 "[codeOcr] [%s] DB-confirmed match found via pass %d (%s) — stopping further passes",
          // CONSOLE-OFF v12 regionLabel, pi + 1, passLabel
        // CONSOLE-OFF v12 );
        break;
      }

      // If we already have codes and we've gone through at least 2 standard passes,
      // don't bother with the slow low-light variants
      if (allCodes.length > 0 && pi >= 1) break;
    }

    const uniqueCodes = [...new Set(allCodes)];
    // CONSOLE-OFF v12 console.log(
      // CONSOLE-OFF v12 "[codeOcr] [%s] region done — codes=%o  bestRaw=%o  dbCandidates=%d  matchedCode=%s",
      // CONSOLE-OFF v12 regionLabel, uniqueCodes, bestRaw, dbCandidates.length, firstMatchedCode
    // CONSOLE-OFF v12 );
    return {
      codes:          uniqueCodes,
      raw:            bestRaw,
      cropCanvas:     crop,
      brightness:     diag.brightness,
      contrast:       diag.contrast,
      lowLightWarning,
      dbCandidates,
      matchedCode:    firstMatchedCode,
    };
  }

  // ── Public: scanCodeRegion (v8.3c multi-region) ───────────────────────────────
  // Iterates over CODE_REGIONS (right-bezel first, then bottom-left fallback)
  // and short-circuits on the first DB-confirmed match. Falls back to the best
  // region by raw code count when no region resolves against the DB. Returns:
  //   { codes, raw, cropCanvas, brightness, contrast, lowLightWarning,
  //     dbCandidates, matchedCode, regionUsed }
  //   or null if no crop could be produced from any region.
  // v11.1: optional `abortFlag` is a plain object { aborted:boolean } that the
  // caller can flip to true when another OCR path (e.g. name OCR) has already
  // produced a confident result. We check it between regions AND inside
  // _scanOneCrop's pass loop so the remaining preprocessing passes / regions
  // stop immediately instead of burning CPU and updating the debug canvas.
  async function scanCodeRegion(frameCanvas, abortFlag) {
    let worker;
    try {
      worker = await getCodeWorker();
    } catch (e) {
      // CONSOLE-OFF v12 console.warn("[codeOcr] worker init failed:", e);
      return null;
    }

    const results = [];
    for (const region of CODE_REGIONS) {
      if (abortFlag && abortFlag.aborted) {
        // CONSOLE-OFF v12 console.log("[codeOcr] scanCodeRegion: aborted before region '%s' (name OCR already won)", region.name);
        break;
      }
      const crop = cropRegionFromCard(frameCanvas, region);
      if (!crop) continue;

      const r = await _scanOneCrop(crop, worker, region.name, abortFlag);
      results.push({ region, result: r });

      // Short-circuit on first DB-confirmed match — don't waste time on the
      // secondary region if the primary one already resolved the card.
      if (r.dbCandidates && r.dbCandidates.length > 0) {
        // CONSOLE-OFF v12 console.log("[codeOcr] scanCodeRegion: DB hit in region '%s' — skipping fallback region(s)", region.name);
        r.regionUsed = region.name;
        return r;
      }

      if (abortFlag && abortFlag.aborted) {
        // CONSOLE-OFF v12 console.log("[codeOcr] scanCodeRegion: aborted after region '%s'", region.name);
        break;
      }
    }

    if (results.length === 0) {
      // CONSOLE-OFF v12 console.log("[codeOcr] scanCodeRegion: every region produced a null crop");
      return null;
    }

    // No DB hit — pick the region with the most extracted codes (tiebreak: most
    // raw text length, then first region).
    results.sort((a, b) => {
      const ac = a.result.codes.length, bc = b.result.codes.length;
      if (ac !== bc) return bc - ac;
      return (b.result.raw || "").length - (a.result.raw || "").length;
    });
    const best = results[0];
    best.result.regionUsed = best.region.name;
    // CONSOLE-OFF v12 console.log(
      // CONSOLE-OFF v12 "[codeOcr] scanCodeRegion: no DB hit in any region; falling back to '%s' (%d codes, %d chars raw)",
      // CONSOLE-OFF v12 best.region.name, best.result.codes.length, (best.result.raw || "").length
    // CONSOLE-OFF v12 );
    return best.result;
  }

  // ── Public exports ────────────────────────────────────────────────────────────
  window.ScannerParts.codeOcr = {
    scanCodeRegion,
    extractCodes,
    cropCodeRegion,        // legacy single-region helper
    cropRegionFromCard,    // v8.3c: explicit region selector
    terminateCodeWorker,
    CODE_REGION,           // legacy
    CODE_REGIONS,          // v8.3c: array of named regions
    // Diagnostics thresholds exposed for console adjustment
    LOW_BRIGHTNESS_THRESHOLD,
    LOW_CONTRAST_THRESHOLD,
  };
})();
