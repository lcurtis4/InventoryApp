// js/scanner/geometry.js  — SCAN WHERE THE OVERLAY SHOWS (with pixel offsets)
(function () {
  "use strict";

  window.ScannerParts = window.ScannerParts || {};

  const ctx2d = (c, frequent) =>
    c && c.getContext
      ? c.getContext("2d", frequent ? { willReadFrequently: true } : undefined)
      : null;

  // Pull tunables from constants (kept for band height + trimming, etc.)
  const C = window.ScannerParts.CONST || {};
  const TRIM_LOW_COL_FACTOR   = Number(C.TRIM_LOW_COL_FACTOR   ?? 0.18);
  const TRIM_ROW_FACTOR       = Number(C.TRIM_ROW_FACTOR       ?? 0.22);
  const TRIM_MIN_WIDTH_PCT    = Number(C.TRIM_MIN_WIDTH_PCT    ?? 0.45);
  const TRIM_MIN_HEIGHT_PCT   = Number(C.TRIM_MIN_HEIGHT_PCT   ?? 0.35);

  const BAND_HEIGHT_FACTORS   = Array.isArray(C.BAND_HEIGHT_FACTORS)
    ? C.BAND_HEIGHT_FACTORS : [0.065, 0.075, 0.085];

  const MIN_BAND_ENERGY       = Number(C.MIN_BAND_ENERGY       ?? 5.0);

  // 🎯 IMPORTANT: these mirror the visual overlay-style guide.
  // Adjust these to move/resize the scanned region (fractions of the visible video box).
  const GUIDE_MARGIN_X_FRAC = 0.06;   // left/right margin % of visible video
  const GUIDE_TOP_FRAC      = 0.150;  // from top of visible video (↑ increase to move DOWN)
  const GUIDE_HEIGHT_FRAC   = 0.120;  // height of scan window (increase = taller)

  // NEW: precise pixel nudges applied after the fractional placement (source pixels).
  // Positive X = shift RIGHT, Positive Y = shift DOWN.
  // ~80 px ≈ ~2 cm, ~160 px ≈ ~4 cm on many 720p/1080p previews — tune if needed.
  const GUIDE_OFFSET_X_PX   = 80;     // ← shift RIGHT ~2 cm
  const GUIDE_OFFSET_Y_PX   = 160;    // ← shift DOWN  ~4 cm

  // Shared helpers from bandDetect if present
  const B = window.ScannerParts.band || {};

  function sobelMagLocal(canvas) {
    const ctx = ctx2d(canvas, true);
    const { width: w, height: h } = canvas;
    const data = ctx.getImageData(0, 0, w, h).data;

    const gray = new Float32Array(w * h);
    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
      gray[j] = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    }

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

  function scoreBand(frameCanvas, y, h, x0, w0) {
    const band = document.createElement("canvas");
    band.width = w0;
    band.height = h;
    ctx2d(band, true).drawImage(frameCanvas, x0, y, w0, h, 0, 0, w0, h);

    const sobel = (B.sobelMag || sobelMagLocal)(band);
    const { mag, w, h: hh } = sobel;

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

    // Trim weak edges
    const COL_CUTOFF = peakCol * TRIM_LOW_COL_FACTOR;
    let left = 0, right = w - 1;
    while (left < right && col[left] < COL_CUTOFF) left++;
    while (right > left && col[right] < COL_CUTOFF) right--;

    const ROW_CUTOFF = peakRow * TRIM_ROW_FACTOR;
    let top = 0, bottom = hh - 1;
    while (top < bottom && row[top] < ROW_CUTOFF) top++;
    while (bottom > top && row[bottom] < ROW_CUTOFF) bottom--;

    // Fallbacks if over-trimmed
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

    // Score by variance + density
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

  // Map the on-screen guide box (overlay coords) back into SOURCE video pixels
  function computeGuideRectInSource(frameCanvas) {
    const v = document.getElementById("video");
    if (!v || !v.videoWidth || !v.videoHeight) return null;

    // Visible video box size (CSS pixels)
    const ow = v.clientWidth || v.videoWidth;
    const oh = v.clientHeight || v.videoHeight;

    // Native source size
    const sw = v.videoWidth;
    const sh = v.videoHeight;

    // object-fit: cover — how the visible box maps onto the source
    const scale = Math.max(ow / sw, oh / sh);
    const visSrcW = ow / scale;
    const visSrcH = oh / scale;
    const srcOffsetX = (sw - visSrcW) / 2;
    const srcOffsetY = (sh - visSrcH) / 2;

    // Overlay guide fractions → visible box pixels → source pixels (+ pixel nudges)
    const gx = srcOffsetX + visSrcW * GUIDE_MARGIN_X_FRAC + GUIDE_OFFSET_X_PX; // ← RIGHT nudge
    const gy = srcOffsetY + visSrcH * GUIDE_TOP_FRAC      + GUIDE_OFFSET_Y_PX; // ← DOWN  nudge
    const gw = visSrcW * (1 - 2 * GUIDE_MARGIN_X_FRAC);
    const gh = visSrcH * GUIDE_HEIGHT_FRAC;

    // Clamp to the actual frame canvas (should match source dims)
    const W = frameCanvas.width, H = frameCanvas.height;
    const x = Math.max(0, Math.min(W - 1, Math.round(gx)));
    const y = Math.max(0, Math.min(H - 1, Math.round(gy)));
    const w = Math.max(1, Math.min(W - x, Math.round(gw)));
    const h = Math.max(1, Math.min(H - y, Math.round(gh)));
    return { x, y, w, h };
  }

  // Public: find the title band, but ONLY inside the guide rect (in source pixels)
  function findTitleBand(frameCanvas) {
    const guide = computeGuideRectInSource(frameCanvas);
    // If we can’t compute (very early), fallback to a centered strip near top
    const fallback = () => {
      const H = frameCanvas.height, W = frameCanvas.width;
      const y = Math.floor(H * 0.10);
      const h = Math.floor(H * 0.10);
      return { x: Math.floor(W * 0.06), y, w: Math.floor(W * 0.88), h };
    };
    const region = guide || fallback();

    let best = null;
    for (const hf of BAND_HEIGHT_FACTORS) {
      // Use band heights relative to the guide region (not the whole frame)
      const bandH = Math.max(1, Math.floor(region.h * hf));
      // Sweep only inside guide
      const yStart = region.y;
      const yEnd = region.y + region.h - bandH;
      const yStep = Math.max(6, Math.floor(region.h * 0.08)); // coarse step within guide

      for (let y = yStart; y <= yEnd; y += yStep) {
        const cand = scoreBand(frameCanvas, y, bandH, region.x, region.w);
        if (!best || cand._rect.score > best._rect.score) best = cand;
      }
    }

    if (!best) {
      const out = document.createElement("canvas");
      out.width = region.w;
      out.height = Math.max(1, Math.floor(region.h * (BAND_HEIGHT_FACTORS[1] || 0.075)));
      out._rect = { x: region.x, y: region.y, w: region.w, h: out.height, score: 0 };
      return out;
    }
    if (best._rect.score < MIN_BAND_ENERGY) best._tooEmpty = true;
    return best;
  }

  window.ScannerParts.geometry = { findTitleBand };
})();
