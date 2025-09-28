// js/scanner/overlay.js
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

  function setGuide(opts = {}) { Object.assign(GUIDE, opts || {}); }

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

  function drawOverlay() {
    const c = ensureOverlayCanvas();
    if (!c) return;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);

    // Card aspect ratio (from constants.js or default 59:86)
    const cardAspect = (window.ScannerParts.CONST && window.ScannerParts.CONST.CARD_ASPECT_WH) || (59 / 86);

    // Fit card rectangle to ~80% of the overlay height
    const targetH = c.height * 0.8;
    const targetW = targetH * cardAspect;

    const x = (c.width - targetW) / 2;
    const y = (c.height - targetH) / 2;

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

    ctx.restore();
  }

  window.ScannerParts.overlay = { syncOverlaySize, drawOverlay, setGuide };
})();
