// js/scanner/overlay.js  — v15 (issue #54: set-code scan removal)
//
// The set-code crop overlay + DEV drag tooling were removed with the automatic
// set-code OCR pipeline (issue #54). What remains is the card guide rectangle
// plus the NAME-BAND overlay (#8) — a dashed yellow (#ffcc00) rectangle over the
// detected title band the name OCR reads.
//
// Coordinate systems:
//   • Card guide: display-pixel rect centered in the overlay canvas.
//   • Name band: source-pixel rect (from geometry.js) → display pixels via the
//     object-fit:cover transform.
(function () {
  "use strict";

  window.ScannerParts = window.ScannerParts || {};
  const el = (id) => document.getElementById(id);

  const GUIDE = {
    stroke:      "#00aaff",       // blue outline
    lineWidth:   3,
    dash:        [10, 6],
    cornerText:  "Place card here",
    textColor:   "#00aaff",
  };

  const CODE_STROKE = "#ffcc00";  // dashed yellow — name band

  function setGuide(opts = {}) { Object.assign(GUIDE, opts || {}); }

  // ── Overlay canvas ──────────────────────────────────────────────────────────
  function ensureOverlayCanvas() {
    const v = el("video");
    if (!v) return null;

    let c = el("overlay") || el("overlayCanvas");
    if (!c) {
      c = document.createElement("canvas");
      c.id = "overlay";
      c.style.position = "absolute";
      c.style.left = "0";
      c.style.top = "0";
      c.style.pointerEvents = "none";
      c.style.zIndex = "10";
      const parent = v.parentElement || document.body;
      if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
      parent.appendChild(c);
    }

    const w = v.clientWidth || v.videoWidth || 640;
    const h = v.clientHeight || v.videoHeight || 480;
    c.width = w;
    c.height = h;
    c.style.width = w + "px";
    c.style.height = h + "px";
    return c;
  }

  function syncOverlaySize() { ensureOverlayCanvas(); }

  // Compute the on-screen card guide rect (display pixels).
  function _cardGuideRect(c) {
    const cardAspect =
      (window.ScannerParts.CONST && window.ScannerParts.CONST.CARD_ASPECT_WH) || (59 / 86);
    const targetH = c.height * 0.8;
    const targetW = targetH * cardAspect;
    const x = (c.width - targetW) / 2;
    const y = (c.height - targetH) / 2;
    return { x, y, w: targetW, h: targetH };
  }

  // Map a SOURCE-video-pixel rect (e.g. the detected name band) into overlay
  // display pixels using the object-fit:cover transform. Mirrors the inverse of
  // geometry.computeGuideRectInSource(). Returns null if the video isn't ready.
  function _sourceRectToDisplay(srcRect) {
    const v = el("video");
    if (!v || !v.videoWidth || !v.videoHeight || !srcRect) return null;
    const ow = v.clientWidth || v.videoWidth;
    const oh = v.clientHeight || v.videoHeight;
    const sw = v.videoWidth;
    const sh = v.videoHeight;
    const scale = Math.max(ow / sw, oh / sh);
    const visSrcW = ow / scale;
    const visSrcH = oh / scale;
    const srcOffsetX = (sw - visSrcW) / 2;
    const srcOffsetY = (sh - visSrcH) / 2;
    return {
      x: (srcRect.x - srcOffsetX) * scale,
      y: (srcRect.y - srcOffsetY) * scale,
      w: srcRect.w * scale,
      h: srcRect.h * scale,
    };
  }

  // ── Main draw ───────────────────────────────────────────────────────────────
  function drawOverlay() {
    const c = ensureOverlayCanvas();
    if (!c) return;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);

    const card = _cardGuideRect(c);
    const { x, y, w: targetW, h: targetH } = card;

    ctx.save();
    ctx.lineWidth = GUIDE.lineWidth;
    ctx.strokeStyle = GUIDE.stroke;
    if (Array.isArray(GUIDE.dash)) ctx.setLineDash(GUIDE.dash);

    ctx.strokeRect(x, y, targetW, targetH);

    if (GUIDE.cornerText) {
      ctx.font = "16px system-ui, -apple-system, Segoe UI, Roboto, Arial";
      ctx.fillStyle = GUIDE.textColor;
      ctx.textBaseline = "bottom";
      ctx.textAlign = "center";
      ctx.fillText(GUIDE.cornerText, c.width / 2, y - 10);
    }

    // ── Name-band overlay (#8) — dashed yellow over the detected title band ───
    // The band is detected in SOURCE pixels by geometry.js; map it to display
    // pixels. Falls back to the static guide-band fractions if no band detected
    // yet (e.g. before the first scan), so the user always sees a name region.
    const lastRect =
      window.ScannerParts._internal &&
      typeof window.ScannerParts._internal.lastDetectedRect === "function"
        ? window.ScannerParts._internal.lastDetectedRect()
        : null;
    let nameRect = _sourceRectToDisplay(lastRect);
    if (!nameRect) {
      // Fallback: mirror geometry's guide fractions on the visible video box.
      nameRect = {
        x: c.width * 0.06,
        y: c.height * 0.15,
        w: c.width * 0.88,
        h: c.height * 0.12,
      };
    }
    ctx.lineWidth = 2;
    ctx.strokeStyle = CODE_STROKE;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(nameRect.x, nameRect.y, nameRect.w, nameRect.h);
    ctx.fillStyle = CODE_STROKE;
    ctx.textBaseline = "bottom";
    ctx.textAlign = "left";
    ctx.font = "11px system-ui, -apple-system, Segoe UI, Roboto, Arial";
    ctx.fillText("name", nameRect.x + 2, nameRect.y - 2);

    ctx.restore();
  }

  window.ScannerParts.overlay = {
    syncOverlaySize, drawOverlay, setGuide,
  };
})();
