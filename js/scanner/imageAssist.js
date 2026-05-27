// js/scanner/imageAssist.js  — v8
//
// Image Recognition Assist — browser-only visual similarity scoring
// ================================================================
//
// FEASIBILITY ASSESSMENT
// ─────────────────────
// Full card recognition from camera frames against a full YGO catalog
// (~15,000+ cards) is NOT feasible browser-only without a backend:
//   • Storing feature embeddings for 15K+ cards would require 10–100 MB
//     of pre-computed data per session.
//   • Running a CNN/embedding model (e.g. MobileNet) in-browser via TF.js
//     is possible but would add ~8 MB of model download + significant CPU.
//   • Comparing against all 15K embeddings per frame is too slow for
//     real-time scanning on mobile devices.
//
// WHAT WE DO INSTEAD (browser-feasible)
// ─────────────────────────────────────
// After code OCR or name OCR has already narrowed the field to a small
// candidate set (typically 1–10 cards), we:
//   1. Crop the card art region from the live camera frame.
//   2. Fetch the YGOPRODeck small thumbnail for each candidate (~30 KB each).
//   3. Downscale both the camera crop and each thumbnail to 32×32 pixels.
//   4. Compute a normalized pixel histogram correlation (Pearson) between them.
//      This is a simple but effective similarity measure for card art.
//   5. Boost or penalize each candidate's existing text-match score by the
//      visual similarity score (weighted at 30% visual, 70% text).
//
// This approach:
//   ✓ Works 100% browser-only (no backend)
//   ✓ Handles up to ~20 candidates without perceptible lag
//   ✓ Improves disambiguation when code/name OCR finds multiple printings
//     of the same card in different sets (different art is rare but possible)
//   ✗ Cannot identify a card from zero candidates (not a full lookup)
//   ✗ Accuracy depends on camera angle, lighting, and card condition
//   ✗ Will not distinguish cards with identical or very similar art
//
// ARCHITECTURE HOOK FOR FUTURE BACKEND
// ─────────────────────────────────────
// window.ImageAssist.backendHook is a replaceable async function:
//   async (artCropDataURL, candidates) => scoredCandidates[]
// When a backend is available, replace this function with a call to your
// image recognition API. The returned array should add an `imgScore` field
// (0–1) to each candidate object. The v8 UI will use it automatically.
//
// To enable: window.ImageAssist.backendHook = async (dataUrl, cands) => { … }

(function () {
  "use strict";

  window.ScannerParts = window.ScannerParts || {};

  // ── Tuning constants ─────────────────────────────────────────────────────────
  // Card art occupies roughly the top 50-55% of card height (below name/type headers).
  // Fractions are relative to the estimated card face rect (same origin as codeOcr.js).
  const ART_REGION = {
    fromTopFrac:    0.12,  // art starts ~12% from card top (below name band)
    heightFrac:     0.40,  // art occupies ~40% of card height
    fromLeftFrac:   0.05,  // small inset from left edge
    widthFrac:      0.90,  // most of card width
    minW:           40,
    minH:           40,
  };

  // Thumbnail comparison size (32×32 is fast and sufficient for rough similarity)
  const THUMB_SIZE = 32;

  // Visual weight in final blended score
  const VIS_WEIGHT  = 0.30;
  const TEXT_WEIGHT = 0.70;

  // Max candidates to run image scoring on (avoid hanging on huge result sets)
  const MAX_CANDIDATES_FOR_VIS = 12;

  // Thumbnail fetch timeout
  const THUMB_TIMEOUT_MS = 4000;

  // ── Canvas helpers ───────────────────────────────────────────────────────────
  const ctx2d = (c) => c && c.getContext && c.getContext("2d", { willReadFrequently: true });

  function downscale(canvas, size) {
    const out = document.createElement("canvas");
    out.width  = size;
    out.height = size;
    ctx2d(out).drawImage(canvas, 0, 0, size, size);
    return out;
  }

  function getPixels(canvas) {
    const c = ctx2d(canvas);
    if (!c) return null;
    return c.getImageData(0, 0, canvas.width, canvas.height).data;
  }

  // Grayscale flatten for comparison
  function toGray(pixels) {
    const n = pixels.length / 4;
    const gray = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      gray[i] = pixels[i * 4] * 0.299 + pixels[i * 4 + 1] * 0.587 + pixels[i * 4 + 2] * 0.114;
    }
    return gray;
  }

  // Pearson correlation coefficient (−1..1; we clamp to 0..1)
  function pearson(a, b) {
    const n = a.length;
    if (!n || a.length !== b.length) return 0;
    let sumA = 0, sumB = 0;
    for (let i = 0; i < n; i++) { sumA += a[i]; sumB += b[i]; }
    const mA = sumA / n, mB = sumB / n;
    let num = 0, dA = 0, dB = 0;
    for (let i = 0; i < n; i++) {
      const da = a[i] - mA, db = b[i] - mB;
      num += da * db;
      dA  += da * da;
      dB  += db * db;
    }
    const den = Math.sqrt(dA * dB);
    if (den < 1e-9) return 0;
    return Math.max(0, Math.min(1, (num / den + 1) / 2)); // normalize −1..1 → 0..1
  }

  // ── Crop card art from frame ─────────────────────────────────────────────────
  function cropArtRegion(frameCanvas) {
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

    // Match geometry.js guide constants exactly
    const GUIDE_MARGIN_X_FRAC = 0.06;
    const GUIDE_TOP_FRAC      = 0.150;
    const GUIDE_HEIGHT_FRAC   = 0.120;
    const GUIDE_OFFSET_X_PX   = 80;
    const GUIDE_OFFSET_Y_PX   = 160;

    const gx = srcOffsetX + visSrcW * GUIDE_MARGIN_X_FRAC + GUIDE_OFFSET_X_PX;
    const gy = srcOffsetY + visSrcH * GUIDE_TOP_FRAC      + GUIDE_OFFSET_Y_PX;
    const gw = visSrcW * (1 - 2 * GUIDE_MARGIN_X_FRAC);

    const CARD_ASPECT = (window.ScannerParts.CONST && window.ScannerParts.CONST.CARD_ASPECT_WH) || (59 / 86);
    const cardW = gw;
    const cardH = cardW / CARD_ASPECT;

    const R = ART_REGION;
    const cropY = Math.floor(gy + cardH * R.fromTopFrac);
    const cropX = Math.floor(gx + cardW * R.fromLeftFrac);
    const cropH = Math.floor(cardH * R.heightFrac);
    const cropW = Math.floor(cardW * R.widthFrac);

    const W = frameCanvas.width;
    const H = frameCanvas.height;
    const x = Math.max(0, Math.min(W - 1, cropX));
    const y = Math.max(0, Math.min(H - 1, cropY));
    const w = Math.max(1, Math.min(W - x, cropW));
    const h = Math.max(1, Math.min(H - y, cropH));

    if (w < R.minW || h < R.minH) return null;

    const out = document.createElement("canvas");
    out.width  = w;
    out.height = h;
    ctx2d(out).drawImage(frameCanvas, x, y, w, h, 0, 0, w, h);
    out._srcRect = { x, y, w, h };
    return out;
  }

  // ── Fetch and downscale a thumbnail from URL ─────────────────────────────────
  // Returns a THUMB_SIZE×THUMB_SIZE canvas or null on error.
  const _thumbCache = new Map();
  function fetchThumb(url) {
    if (_thumbCache.has(url)) return _thumbCache.get(url);

    const p = new Promise((resolve) => {
      if (!url) return resolve(null);
      const img = new Image();
      img.crossOrigin = "anonymous";
      const timeout = setTimeout(() => resolve(null), THUMB_TIMEOUT_MS);
      img.onload = () => {
        clearTimeout(timeout);
        try {
          const c = document.createElement("canvas");
          c.width  = THUMB_SIZE;
          c.height = THUMB_SIZE;
          ctx2d(c).drawImage(img, 0, 0, THUMB_SIZE, THUMB_SIZE);
          resolve(c);
        } catch { resolve(null); }
      };
      img.onerror = () => { clearTimeout(timeout); resolve(null); };
      img.src = url;
    });

    _thumbCache.set(url, p);
    return p;
  }

  // ── Score candidates visually ────────────────────────────────────────────────
  // candidates: array of { name, id, imageUrl, score, ... }
  // frameCanvas: the current camera frame
  //
  // Returns a new array with an added `imgScore` field (0–1) and a
  // `blendedScore` field that combines text score + visual score.
  async function scoreVisually(candidates, frameCanvas) {
    if (!Array.isArray(candidates) || !candidates.length || !frameCanvas) {
      return candidates.map(c => ({ ...c, imgScore: null, blendedScore: c.score || 0 }));
    }

    // Check for backend hook override first
    if (typeof window.ImageAssist?.backendHook === "function") {
      try {
        const artCrop = cropArtRegion(frameCanvas);
        if (artCrop) {
          const dataUrl = artCrop.toDataURL("image/jpeg", 0.7);
          const result  = await window.ImageAssist.backendHook(dataUrl, candidates);
          if (Array.isArray(result) && result.length) return result;
        }
      } catch (e) {
        // CONSOLE-OFF v12 console.warn("[imageAssist] backend hook failed, falling back to browser path:", e);
      }
    }

    // Browser-only path
    const artCrop = cropArtRegion(frameCanvas);
    if (!artCrop) {
      return candidates.map(c => ({ ...c, imgScore: null, blendedScore: c.score || 0 }));
    }

    const artThumb  = downscale(artCrop, THUMB_SIZE);
    const artPixels = getPixels(artThumb);
    if (!artPixels) {
      return candidates.map(c => ({ ...c, imgScore: null, blendedScore: c.score || 0 }));
    }
    const artGray = toGray(artPixels);

    // Limit to MAX_CANDIDATES_FOR_VIS
    const toScore = candidates.slice(0, MAX_CANDIDATES_FOR_VIS);

    // Fetch all thumbnails in parallel
    const thumbPromises = toScore.map(c => fetchThumb(c.imageUrl || null));
    const thumbCanvases = await Promise.all(thumbPromises);

    const scored = toScore.map((c, i) => {
      const thumb = thumbCanvases[i];
      if (!thumb) {
        return { ...c, imgScore: null, blendedScore: (c.score || 0) };
      }
      const thumbPixels = getPixels(thumb);
      if (!thumbPixels) {
        return { ...c, imgScore: null, blendedScore: (c.score || 0) };
      }
      const thumbGray = toGray(thumbPixels);
      const imgScore  = pearson(artGray, thumbGray);
      const textScore = typeof c.score === "number" ? c.score : 0;
      const blended   = TEXT_WEIGHT * textScore + VIS_WEIGHT * imgScore;
      return { ...c, imgScore, blendedScore: blended };
    });

    // Append any candidates beyond MAX_CANDIDATES_FOR_VIS unscored
    const unscored = candidates.slice(MAX_CANDIDATES_FOR_VIS).map(c => ({
      ...c, imgScore: null, blendedScore: c.score || 0,
    }));

    // Sort by blended score desc
    return [...scored, ...unscored].sort((a, b) => b.blendedScore - a.blendedScore);
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  const ImageAssist = {
    scoreVisually,
    cropArtRegion,   // exposed for debug

    // Backend hook: replace this to plug in a server-side vision model.
    // Signature: async (artCropDataURL: string, candidates: object[]) => object[]
    // The returned array must include an `imgScore` (0–1) and `blendedScore` field.
    backendHook: null,

    // Expose constants for user tuning
    ART_REGION,
    VIS_WEIGHT,
    TEXT_WEIGHT,

    // Limitations notice for UI display
    LIMITATIONS: [
      "Browser-only visual scoring compares card art at 32×32 pixels.",
      "Effective only when code/name OCR has already narrowed to <12 candidates.",
      "Cannot identify cards with no prior code/name hint.",
      "Similar-art cards may score comparably; code OCR remains primary signal.",
      "To enable full image recognition, set window.ImageAssist.backendHook to an async function.",
    ],
  };

  window.ScannerParts.imageAssist = ImageAssist;
  window.ImageAssist = ImageAssist;
})();
