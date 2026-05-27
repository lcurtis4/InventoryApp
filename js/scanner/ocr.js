// js/scanner/ocr.js  — v8.3 (was v7.1)
// v8.3: added console log on every name OCR pass so the per-pass attempts are
//       visible alongside the new code OCR logs.
// FIX 1 (primary — "OCR in progress" stuck):
//   v7 called Tesseract.recognize() for every tryOnce pass.  In Tesseract.js v5
//   that helper spawns + terminates a brand-new Web Worker each time, meaning the
//   browser had to re-download eng.traineddata (10-45 MB) up to 5 times in a row.
//   Wall-clock time: 10–50+ seconds → scanner appeared frozen on "OCR in progress".
//   Fix: create one persistent worker at init time, reuse it across all passes and
//   all scan cycles, terminate only when the scanner stops.
//
// FIX 2 (secondary — PSM 7 and char-whitelist silently ignored):
//   v7 passed { tessedit_pageseg_mode, tessedit_char_whitelist } as the third
//   argument to Tesseract.recognize().  In v5 that argument is forwarded to
//   createWorker() as worker-level *init* options (workerPath, langPath, …) and
//   the recognition parameters are simply discarded.
//   Fix: pass the params object as the second argument to worker.recognize() where
//   Tesseract v5 actually honours them.
(function () {
  "use strict";

  window.ScannerParts = window.ScannerParts || {};

  // Optional preprocessor (upscale/sharpen/binarize)
  const Pre = window.ScannerParts.preprocess || {};

  // Safe debug hook
  function dbgShow(srcCanvas, info) {
    try {
      const fn =
        (window.ScannerParts.debug && window.ScannerParts.debug.show) ||
        window.showDebug;
      if (typeof fn === "function") fn(srcCanvas, info || {});
    } catch (_) { /* ignore */ }
  }

  // ── Persistent worker ────────────────────────────────────────────────────────
  // One worker is created on first use and reused for every recognition pass.
  // This avoids the per-call spawn+traineddata-download that caused the freeze.

  let _worker = null;          // Tesseract.Worker instance (v5)
  let _workerReady = false;    // true once loadLanguage + initialize have completed
  let _workerPromise = null;   // single in-flight init promise (prevents double-init)

  async function getWorker() {
    if (_workerReady && _worker) return _worker;

    if (_workerPromise) return _workerPromise;

    _workerPromise = (async () => {
      // createWorker(langs, oem, workerOptions)
      // Omit recognition params here — they belong in worker.recognize().
      _worker = await Tesseract.createWorker("eng", 1, {
        // Keep logging quiet in production; flip to true for debugging.
        logger: () => {},
      });
      _workerReady = true;
      return _worker;
    })();

    try {
      const w = await _workerPromise;
      return w;
    } catch (err) {
      // Reset so the next scan attempt retries init.
      _worker = null;
      _workerReady = false;
      _workerPromise = null;
      throw err;
    }
  }

  // Call this when the scanner stops so memory is released.
  async function terminateWorker() {
    _workerReady = false;
    _workerPromise = null;
    if (_worker) {
      try { await _worker.terminate(); } catch (_) {}
      _worker = null;
    }
  }

  // ── Text normalization ───────────────────────────────────────────────────────
  // Mirrors lookup/normalize.js: strip quotes, normalize separators, title-case.

  function normalizeName(s) {
    if (!s) return "";
    let t = String(s);

    t = t.replace(/["""''`]/g, "");
    t = t.replace(/[|_•·]/g, "-");
    t = t.replace(/[^\w\s\-\&\!\?:,\.]/g, " ");
    t = t.replace(/\s+/g, " ").trim();
    t = t.replace(/\s*-\s*/g, "-");

    if (t && (t === t.toUpperCase() || t === t.toLowerCase())) {
      t = t
        .split(" ")
        .map(w => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
        .join(" ");
    }
    return t.trim();
  }

  // ── Recognition parameters ───────────────────────────────────────────────────
  // These are passed as the second arg to worker.recognize() in v5, which is
  // where Tesseract.js actually applies them.

  const TESS_PARAMS = {
    tessedit_pageseg_mode: "7",          // PSM 7 — single text line
    tessedit_char_whitelist:
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz -'&!?:,./0123456789",
  };

  // ── scanBand ─────────────────────────────────────────────────────────────────
  // Run OCR over the detected title band.  Uses one shared worker for all passes.

  async function scanBand(band) {
    const FAST = [{ inv: false, th: 180, sc: 2 }];
    const FALL = [
      { inv: false, th: 165, sc: 2 },
      { inv: false, th: 195, sc: 2 },
      { inv: true,  th: 180, sc: 2 },
      { inv: false, th: 180, sc: 2.5 },
    ];

    const tries = [];

    // Obtain the shared worker once (waits if init is still in progress).
    const worker = await getWorker();

    async function tryOnce(inv, th, sc) {
      const pre =
        (Pre.upscaleSharpenAndBinarize &&
          Pre.upscaleSharpenAndBinarize(band, sc, th, inv)) ||
        band;

      // FIX 2: recognition parameters go in the second arg to worker.recognize().
      const { data } = await worker.recognize(pre, TESS_PARAMS);

      const raw  = String(data?.text || "").replace(/\s+/g, " ").trim();
      const text = normalizeName(raw);
      const conf = typeof data?.confidence === "number"
        ? Math.max(0, Math.min(100, Math.round(data.confidence)))
        : undefined;

      // CONSOLE-OFF v12 console.log(
        // CONSOLE-OFF v12 "[ocr] name pass inv=%s th=%s sc=%s → raw=%o  text=%o  acc=%s%%",
        // CONSOLE-OFF v12 inv, th, sc, raw, text, (typeof conf === "number" ? conf : "?")
      // CONSOLE-OFF v12 );
      dbgShow(pre, { text, accuracy: conf });

      if (text) tries.push({ text, pre, conf: conf ?? 0, raw });
      return text;
    }

    // Quick pass first
    let got = null;
    for (const t of FAST) {
      got = await tryOnce(t.inv, t.th, t.sc);
      if (got && got.length >= 5) break;
    }

    // Fallbacks if quick pass returned nothing useful
    if (!got || got.length < 5) {
      for (const t of FALL) {
        const txt = await tryOnce(t.inv, t.th, t.sc);
        if (txt && txt.length >= 5) break;
      }
    }

    if (!tries.length) return null;

    // Best = longest normalized text, then highest confidence as tie-break
    tries.sort((a, b) => {
      if (b.text.length !== a.text.length) return b.text.length - a.text.length;
      return (b.conf || 0) - (a.conf || 0);
    });

    const best = tries[0];
    dbgShow(best.pre, { text: best.text, accuracy: best.conf });

    return best;
  }

  window.ScannerParts.ocr = { normalizeName, scanBand, terminateWorker };
})();
