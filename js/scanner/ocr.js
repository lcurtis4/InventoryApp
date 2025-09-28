// js/scanner/ocr.js
(function () {
  "use strict";

  window.ScannerParts = window.ScannerParts || {};

  // Optional preprocessor (upscale/sharpen/binarize)
  const Pre = window.ScannerParts.preprocess || {};

  // Safe debug hook: call overlay debug if available, otherwise no-op
  function dbgShow(srcCanvas, info) {
    try {
      const fn =
        (window.ScannerParts.debug && window.ScannerParts.debug.show) ||
        window.showDebug; // legacy global if defined
      if (typeof fn === "function") fn(srcCanvas, info || {});
    } catch (_) {
      /* ignore */
    }
  }

  // Normalize OCR text into a consistent, fuzzy-friendly name
  // Mirrors lookup/normalize.js behavior: strip quotes, normalize separators, title-case when appropriate.
  function normalizeName(s) {
    if (!s) return "";
    let t = String(s);

    // Strip straight & curly quotes entirely so `"Ripper"` ≈ Ripper
    t = t.replace(/[“”"‘’`]/g, "");

    // Normalize separators (tesseract often produces underscores/pipes/dots)
    t = t.replace(/[|_•·]/g, "-");

    // Keep letters/digits/space/hyphen & a few safe punctuation marks used in names
    t = t.replace(/[^\w\s\-\&\!\?:,\.]/g, " ");

    // Collapse spaces and normalize spaced hyphens
    t = t.replace(/\s+/g, " ").trim();
    t = t.replace(/\s*-\s*/g, "-");

    // Title-case if the whole string is all-caps or all-lower (typical OCR)
    if (t && (t === t.toUpperCase() || t === t.toLowerCase())) {
      t = t
        .split(" ")
        .map(w => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
        .join(" ");
    }
    return t.trim();
  }

  // Run OCR over the detected title band with a few fast/fallback tries
  async function scanBand(band) {
    // Tuned passes: quick pass first, then a few fallbacks with slight threshold/scale tweaks.
    const FAST = [{ inv: false, th: 180, sc: 2 }];
    const FALL = [
      { inv: false, th: 165, sc: 2 },
      { inv: false, th: 195, sc: 2 },
      { inv: true,  th: 180, sc: 2 },
      { inv: false, th: 180, sc: 2.5 },
    ];

    const tries = [];

    async function tryOnce(inv, th, sc) {
      const pre =
        (Pre.upscaleSharpenAndBinarize &&
          Pre.upscaleSharpenAndBinarize(band, sc, th, inv)) ||
        band;

      // Keep the whitelist permissive but safe; middle dot/star aren’t necessary for OCR here
      const { data } = await Tesseract.recognize(pre, "eng", {
        tessedit_pageseg_mode: 7,
        tessedit_char_whitelist:
          "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz -'&!?:,./0123456789",
      });

      const raw = String(data?.text || "").replace(/\s+/g, " ").trim();
      const text = normalizeName(raw);
      const conf = typeof data?.confidence === "number" ? Math.max(0, Math.min(100, Math.round(data.confidence))) : undefined;

      // Show immediate feedback for this attempt
      dbgShow(pre, { text, accuracy: conf });

      if (text) tries.push({ text, pre, conf: conf ?? 0, raw });
      return text;
    }

    // quick try
    let got = null;
    for (const t of FAST) {
      got = await tryOnce(t.inv, t.th, t.sc);
      if (got && got.length >= 5) break;
    }

    // fallbacks
    if (!got || got.length < 5) {
      for (const t of FALL) {
        const txt = await tryOnce(t.inv, t.th, t.sc);
        if (txt && txt.length >= 5) break;
      }
    }

    if (!tries.length) return null;

    // Choose best by (1) longest normalized text, (2) confidence tie-break
    tries.sort((a, b) => {
      if (b.text.length !== a.text.length) return b.text.length - a.text.length;
      return (b.conf || 0) - (a.conf || 0);
    });

    const best = tries[0];

    // Final debug ping with the chosen version
    dbgShow(best.pre, { text: best.text, accuracy: best.conf });

    // Return shape used by scanner/core.js: { text, pre, ... }
    return best;
  }

  window.ScannerParts.ocr = { normalizeName, scanBand };
})();
