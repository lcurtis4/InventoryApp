// js/scanner/bandDetect.js
(function () {
  "use strict";

  // Namespace
  window.ScannerParts = window.ScannerParts || {};

  // ---- Safe helpers & constants -------------------------------------------
  const ctx2d = (c, frequent) =>
    c && c.getContext
      ? c.getContext("2d", frequent ? { willReadFrequently: true } : undefined)
      : null;

  const C = window.ScannerParts.CONST || {};
  const TRIM_LOW_COL_FACTOR   = Number(C.TRIM_LOW_COL_FACTOR   ?? 0.18);
  const TRIM_ROW_FACTOR       = Number(C.TRIM_ROW_FACTOR       ?? 0.22);
  const TRIM_MIN_WIDTH_PCT    = Number(C.TRIM_MIN_WIDTH_PCT    ?? 0.45);
  const TRIM_MIN_HEIGHT_PCT   = Number(C.TRIM_MIN_HEIGHT_PCT   ?? 0.35);

  const HORIZ_INSET_PCT       = Number(C.HORIZ_INSET_PCT       ?? 0.06);
  const HORIZ_OFFSET_PX       = Number(C.HORIZ_OFFSET_PX       ?? 0);
  const EXTRA_LEFT_PX         = Number(C.EXTRA_LEFT_PX         ?? 18);

  const VERT_SEARCH_TOP_PCT   = Number(C.VERT_SEARCH_TOP_PCT   ?? 0.07);
  const VERT_SEARCH_MAX_PCT   = Number(C.VERT_SEARCH_MAX_PCT   ?? 0.23);
  const VERT_STEP_PCT         = Number(C.VERT_STEP_PCT         ?? 0.02);

  const BAND_HEIGHT_FACTORS   = Array.isArray(C.BAND_HEIGHT_FACTORS)
    ? C.BAND_HEIGHT_FACTORS : [0.065, 0.075, 0.085];

  const MIN_BAND_ENERGY       = Number(C.MIN_BAND_ENERGY       ?? 5.0);

  // ---- Basic image utilities -----------------------------------------------
  function sobelMag(canvas) {
    const ctx = ctx2d(canvas, true);
    const { width: w, height: h } = canvas;
    const img = ctx.getImageData(0, 0, w, h).data;

    // grayscale
    const gray = new Float32Array(w * h);
    for (let i = 0, j = 0; i < img.length; i += 4, j++) {
      gray[j] = img[i] * 0.299 + img[i + 1] * 0.587 + img[i + 2] * 0.114;
    }

    // sobel
    const out = new Float32Array(w * h);
    const gxk = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
    const gyk = [-1, -2, -1, 0, 0, 0, 1, 2, 1];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        let gx = 0, gy = 0, k = 0;
        for (let yy = -1; yy <= 1; yy++) {
          for (let xx = -1; xx <= 1; xx++, k++) {
            const v = gray[(y + yy) * w + (x + xx)];
            gx += v * gxk[k];
            gy += v * gyk[k];
          }
        }
        out[y * w + x] = Math.hypot(gx, gy);
      }
    }
    return { mag: out, w, h };
  }

  function grayscaleVector(c) {
    const ctx = ctx2d(c, true);
    const img = ctx.getImageData(0, 0, c.width, c.height).data;
    const vec = new Float32Array(c.width * c.height);
    for (let i = 0, p = 0; p < img.length; p += 4, i++) {
      vec[i] = img[p] * 0.299 + img[p + 1] * 0.587 + img[p + 2] * 0.114;
    }
    return vec;
  }

  const meanAbsDiff = (a, b) =>
    !a || !b || a.length !== b.length
      ? Infinity
      : a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;

  function contrastEstimate(vec) {
    let m = 0;
    for (const v of vec) m += v;
    m /= vec.length;
    let s = 0;
    for (const v of vec) {
      const d = v - m;
      s += d * d;
    }
    return Math.sqrt(s / vec.length);
  }

  // ---- Band scoring + geometry ---------------------------------------------
  function scoreBand(frameCanvas, y, h, x0, w0) {
    const band = document.createElement("canvas");
    band.width = w0;
    band.height = h;
    ctx2d(band, true).drawImage(frameCanvas, x0, y, w0, h, 0, 0, w0, h);

    const { mag, w, h: hh } = sobelMag(band);

    const col = new Float32Array(w), row = new Float32Array(hh);
    let total = 0, peakCol = 0, peakRow = 0;
    for (let yy = 0; yy < hh; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const v = mag[yy * w + xx];
        col[xx] += v;
        row[yy] += v;
        total += v;
        if (col[xx] > peakCol) peakCol = col[xx];
        if (row[yy] > peakRow) peakRow = row[yy] > peakRow ? row[yy] : peakRow;
      }
    }
    const density = total / (w * hh + 1e-6);

    // trim columns by low energy
    const COL_CUTOFF = peakCol * TRIM_LOW_COL_FACTOR;
    let left = 0, right = w - 1;
    while (left < right && col[left] < COL_CUTOFF) left++;
    while (right > left && col[right] < COL_CUTOFF) right--;

    // trim rows by low energy
    const ROW_CUTOFF = peakRow * TRIM_ROW_FACTOR;
    let top = 0, bottom = hh - 1;
    while (top < bottom && row[top] < ROW_CUTOFF) top++;
    while (bottom > top && row[bottom] < ROW_CUTOFF) bottom--;

    // fallback if trim too aggressive
    const minW = Math.floor(w * TRIM_MIN_WIDTH_PCT);
    const minH = Math.floor(hh * TRIM_MIN_HEIGHT_PCT);
    const trimmedW = Math.max(1, right - left + 1);
    const trimmedH = Math.max(1, bottom - top + 1);
    const effW = trimmedW >= minW ? trimmedW : w;
    const effH = trimmedH >= minH ? trimmedH : hh;

    const srcX = effW === w ? 0 : left;
    const srcY = effH === hh ? 0 : top;

    const out = document.createElement("canvas");
    out.width = effW;
    out.height = effH;
    ctx2d(out, true).drawImage(band, srcX, srcY, effW, effH, 0, 0, effW, effH);

    // score by column variance + overall density
    let mean = 0;
    for (const v of col) mean += v;
    mean /= w;
    let varsum = 0;
    for (const v of col) {
      const d = v - mean;
      varsum += d * d;
    }
    const variance = varsum / w;
    const score = variance * 0.7 + density * 0.3;

    out._rect = { x: x0 + srcX, y: y + srcY, w: effW, h: effH, score }; // native pixels
    return out;
  }

  function detectActiveRegion(frameCanvas) {
    const ctx = ctx2d(frameCanvas, true);
    const { width: W, height: H } = frameCanvas;
    const img = ctx.getImageData(0, 0, W, H).data;

    // Accumulate luminance across several rows near the top of the card
    const rows = [Math.floor(H * 0.10), Math.floor(H * 0.14), Math.floor(H * 0.18)];
    const colEnergy = new Float32Array(W);
    for (const y of rows) {
      let idx = y * W * 4;
      for (let x = 0; x < W; x++, idx += 4) {
        const Y = img[idx] * 0.299 + img[idx + 1] * 0.587 + img[idx + 2] * 0.114;
        colEnergy[x] += Y;
      }
    }
    let max = 0;
    for (let x = 0; x < W; x++) if (colEnergy[x] > max) max = colEnergy[x] || 1;

    const thr = max * 0.06;
    let left = 0, right = W - 1;
    while (left < right && colEnergy[left] < thr) left++;
    while (right > left && colEnergy[right] < thr) right--;

    if (right - left + 1 < W * 0.5) return { x: 0, w: W }; // fallback
    left = Math.max(0, left - 2);
    right = Math.min(W - 1, right + 2);
    return { x: left, w: Math.max(1, right - left + 1) };
  }

  function findTitleBand(frameCanvas) {
    const H = frameCanvas.height;
    const active = detectActiveRegion(frameCanvas);

    // initial horizontal crop (inset from both sides)
    const cropX0 = Math.floor(active.x + active.w * HORIZ_INSET_PCT + HORIZ_OFFSET_PX);
    const cropW0 = Math.floor(active.w * (1 - 2 * HORIZ_INSET_PCT));
    const rightEdge = cropX0 + cropW0;

    // allow pulling the left edge further out without changing right edge
    const cropX = Math.max(0, cropX0 - EXTRA_LEFT_PX);
    const cropW = Math.max(1, Math.min(frameCanvas.width - cropX, rightEdge - cropX));

    const yStart = Math.floor(H * VERT_SEARCH_TOP_PCT);
    const yEnd = Math.floor(H * VERT_SEARCH_MAX_PCT);
    const yStep = Math.max(6, Math.floor(H * VERT_STEP_PCT));

    let best = null;
    for (const hf of BAND_HEIGHT_FACTORS) {
      const bandH = Math.floor(H * hf);
      for (let y = yStart; y + bandH <= yEnd; y += yStep) {
        const cand = scoreBand(frameCanvas, y, bandH, cropX, cropW);
        if (!best || cand._rect.score > best._rect.score) best = cand;
      }
    }

    if (!best) {
      const out = document.createElement("canvas");
      out.width = cropW;
      out.height = Math.floor(H * (BAND_HEIGHT_FACTORS[1] || 0.075));
      out._rect = { x: cropX, y: yStart, w: cropW, h: out.height, score: 0 };
      return out;
    }
    if (best._rect.score < MIN_BAND_ENERGY) best._tooEmpty = true;
    return best;
  }

  // ---- Exports --------------------------------------------------------------
  window.ScannerParts.band = { sobelMag, grayscaleVector, meanAbsDiff, contrastEstimate };
  window.ScannerParts.geometry = { findTitleBand };
})();
