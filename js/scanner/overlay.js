// js/scanner/overlay.js  — v14 (Sprint 3: scanner crop & overlays)
//
// v14 (#7) — DEV DRAG UI for the set-code crop:
//   The set-code scan region (codeOcr.CODE_REGIONS) is drawn as a dashed yellow
//   rectangle inside the card guide. In DEV MODE the rectangle becomes
//   interactive: drag its body to move it, drag the bottom-right handle to
//   resize. On release the new top/left/width/height fractions are persisted to
//   localStorage via codeOcr.saveRegionOverride(), so production builds boot
//   straight to the tuned coordinates. Dev mode is OFF by default and opt-in
//   via the `?devcrop=1` query param OR the Shift+D hotkey; the choice persists
//   across reloads. Production (no flag, no saved dev pref) never shows handles.
//
// v14 (#8) — NAME-BAND OVERLAY:
//   Adds a second dashed yellow (#ffcc00) rectangle over the card NAME band that
//   the title OCR is reading, matching the set-code styling. The name band is
//   detected by geometry.js in SOURCE-video pixels (band._rect); we map it back
//   into overlay/display pixels with the same object-fit:cover transform the
//   set-code crop uses, so both overlays share v14's card-rect coordinate basis.
//
// Coordinate systems:
//   • Set-code region: fractions (top/left/width/height) of the on-screen card
//     guide rect — same basis codeOcr.cropRegionFromCard() uses to crop.
//   • Name band: source-pixel rect → display pixels via cover transform.
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

  const CODE_STROKE = "#ffcc00";  // dashed yellow — shared by set-code + name band

  function setGuide(opts = {}) { Object.assign(GUIDE, opts || {}); }

  // ── Dev-mode state ──────────────────────────────────────────────────────────
  // OFF by default. Enabled by ?devcrop=1 in the URL OR by a persisted pref the
  // Shift+D hotkey toggles. Production builds (no flag, no pref) never enter it.
  const DEV_PREF_KEY = "ygo.devcrop.v14";
  let _devMode = false;

  function _readDevPref() {
    try {
      const qp = new URLSearchParams(location.search || "");
      if (qp.has("devcrop")) {
        const v = qp.get("devcrop");
        return v === "" || v === "1" || v === "true";
      }
      return (typeof localStorage !== "undefined") &&
             localStorage.getItem(DEV_PREF_KEY) === "1";
    } catch (_) { return false; }
  }

  function setDevMode(on) {
    _devMode = !!on;
    try {
      if (typeof localStorage !== "undefined") {
        if (_devMode) localStorage.setItem(DEV_PREF_KEY, "1");
        else localStorage.removeItem(DEV_PREF_KEY);
      }
    } catch (_) {}
    _ensureDevToolbar();
    drawOverlay();
  }
  function isDevMode() { return _devMode; }

  // Shift+D hotkey toggles dev mode at runtime.
  function _installHotkey() {
    if (window.__ygoDevcropHotkey) return;
    window.__ygoDevcropHotkey = true;
    document.addEventListener("keydown", (e) => {
      if (e.shiftKey && (e.key === "D" || e.key === "d") &&
          !e.metaKey && !e.ctrlKey && !e.altKey) {
        const tag = (e.target && e.target.tagName) || "";
        if (tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable) return;
        setDevMode(!_devMode);
      }
    });
  }

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

  // Compute the on-screen card guide rect (display pixels). This is the SAME
  // rect codeOcr's _computeCardRectInSource() is derived from — set-code region
  // fractions are relative to it.
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

  // ── Drag interaction layer (dev mode only) ──────────────────────────────────
  // We can't receive pointer events on the overlay canvas (pointer-events:none),
  // so dev mode installs a transparent sibling that does. Cached geometry from
  // the last draw lets us hit-test the set-code rect + its resize handle.
  let _dragLayer = null;
  let _lastSetCodeRect = null;   // display-pixel rect of the set-code overlay
  let _lastCardRect    = null;   // display-pixel card guide rect
  let _drag = null;              // active drag session

  const HANDLE = 14;             // px size of the bottom-right resize handle

  function _ensureDragLayer() {
    const v = el("video");
    if (!v) return null;
    if (!_dragLayer) {
      _dragLayer = document.createElement("div");
      _dragLayer.id = "codeCropDragLayer";
      _dragLayer.style.cssText =
        "position:absolute;left:0;top:0;z-index:11;touch-action:none;";
      const parent = v.parentElement || document.body;
      parent.appendChild(_dragLayer);
      _installDragHandlers(_dragLayer);
    }
    const c = el("overlay");
    if (c) {
      _dragLayer.style.width = c.width + "px";
      _dragLayer.style.height = c.height + "px";
    }
    return _dragLayer;
  }

  function _removeDragLayer() {
    if (_dragLayer && _dragLayer.parentElement) {
      _dragLayer.parentElement.removeChild(_dragLayer);
    }
    _dragLayer = null;
    _drag = null;
  }

  function _localPoint(ev, layer) {
    const r = layer.getBoundingClientRect();
    const src = ev.touches ? ev.touches[0] : ev;
    return { x: src.clientX - r.left, y: src.clientY - r.top };
  }

  function _inHandle(p, rect) {
    return p.x >= rect.x + rect.w - HANDLE && p.x <= rect.x + rect.w + 4 &&
           p.y >= rect.y + rect.h - HANDLE && p.y <= rect.y + rect.h + 4;
  }
  function _inBody(p, rect) {
    return p.x >= rect.x && p.x <= rect.x + rect.w &&
           p.y >= rect.y && p.y <= rect.y + rect.h;
  }

  function _installDragHandlers(layer) {
    const onDown = (ev) => {
      if (!_devMode || !_lastSetCodeRect || !_lastCardRect) return;
      const p = _localPoint(ev, layer);
      if (_inHandle(p, _lastSetCodeRect)) {
        _drag = { mode: "resize", start: p, rect0: { ..._lastSetCodeRect } };
      } else if (_inBody(p, _lastSetCodeRect)) {
        _drag = { mode: "move", start: p, rect0: { ..._lastSetCodeRect } };
      } else {
        return;
      }
      ev.preventDefault();
    };
    const onMove = (ev) => {
      if (!_drag) return;
      const p = _localPoint(ev, layer);
      const dx = p.x - _drag.start.x;
      const dy = p.y - _drag.start.y;
      const r0 = _drag.rect0;
      const card = _lastCardRect;
      let nx = r0.x, ny = r0.y, nw = r0.w, nh = r0.h;
      if (_drag.mode === "move") {
        nx = Math.max(card.x, Math.min(card.x + card.w - r0.w, r0.x + dx));
        ny = Math.max(card.y, Math.min(card.y + card.h - r0.h, r0.y + dy));
      } else { // resize
        nw = Math.max(20, Math.min(card.x + card.w - r0.x, r0.w + dx));
        nh = Math.max(10, Math.min(card.y + card.h - r0.y, r0.h + dy));
      }
      _lastSetCodeRect = { x: nx, y: ny, w: nw, h: nh };
      // Live-persist as fractions of the card guide so OCR uses it next scan.
      _persistSetCodeRect();
      ev.preventDefault();
      drawOverlay();
    };
    const onUp = () => {
      if (_drag) { _persistSetCodeRect(); _drag = null; drawOverlay(); }
    };
    layer.addEventListener("mousedown", onDown);
    layer.addEventListener("touchstart", onDown, { passive: false });
    window.addEventListener("mousemove", onMove, { passive: false });
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchend", onUp);
  }

  // Convert the current display-pixel set-code rect back into card-relative
  // fractions and persist them via codeOcr.saveRegionOverride().
  function _persistSetCodeRect() {
    const co = window.ScannerParts.codeOcr;
    if (!co || !_lastSetCodeRect || !_lastCardRect) return;
    const card = _lastCardRect;
    const r = _lastSetCodeRect;
    const frac = {
      left:   (r.x - card.x) / card.w,
      top:    (r.y - card.y) / card.h,
      width:  r.w / card.w,
      height: r.h / card.h,
    };
    const regions = co.getActiveRegions ? co.getActiveRegions() : (co.CODE_REGIONS || []);
    const name = regions[0] && regions[0].name;
    if (name && typeof co.saveRegionOverride === "function") {
      co.saveRegionOverride(name, frac);
    }
  }

  // ── Dev toolbar (reset button + hint) ───────────────────────────────────────
  let _devToolbar = null;
  function _ensureDevToolbar() {
    const v = el("video");
    if (!v) return;
    if (_devMode && !_devToolbar) {
      const parent = v.parentElement || document.body;
      _devToolbar = document.createElement("div");
      _devToolbar.id = "codeCropDevToolbar";
      _devToolbar.style.cssText =
        "position:absolute;right:8px;top:8px;z-index:12;display:flex;gap:6px;" +
        "align-items:center;background:rgba(0,0,0,.6);color:#ffcc00;padding:4px 8px;" +
        "border-radius:6px;font:12px system-ui,-apple-system,Segoe UI,Roboto,Arial;";
      const label = document.createElement("span");
      label.textContent = "DEV crop \u2022 drag to tune";
      const reset = document.createElement("button");
      reset.textContent = "Reset";
      reset.style.cssText =
        "font:11px inherit;cursor:pointer;border:1px solid #ffcc00;background:transparent;" +
        "color:#ffcc00;border-radius:4px;padding:1px 6px;";
      reset.addEventListener("click", () => {
        const co = window.ScannerParts.codeOcr;
        if (co && typeof co.resetRegionOverrides === "function") co.resetRegionOverrides();
        drawOverlay();
      });
      _devToolbar.appendChild(label);
      _devToolbar.appendChild(reset);
      parent.appendChild(_devToolbar);
    } else if (!_devMode && _devToolbar) {
      if (_devToolbar.parentElement) _devToolbar.parentElement.removeChild(_devToolbar);
      _devToolbar = null;
    }
  }

  // ── Main draw ───────────────────────────────────────────────────────────────
  function drawOverlay() {
    const c = ensureOverlayCanvas();
    if (!c) return;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);

    const card = _cardGuideRect(c);
    _lastCardRect = card;
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

    // ── Set-code scan region(s) — dashed yellow, card-relative fractions ──────
    // Use the LIVE region list (defaults merged with any dev/localStorage
    // overrides) so the drawn rect always matches what OCR will crop.
    const co = window.ScannerParts.codeOcr;
    const regions =
      (co && typeof co.getActiveRegions === "function")
        ? co.getActiveRegions()
        : ((co && co.CODE_REGIONS) || []);
    _lastSetCodeRect = null;
    if (regions.length) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = CODE_STROKE;
      ctx.setLineDash([4, 3]);
      ctx.font = "11px system-ui, -apple-system, Segoe UI, Roboto, Arial";
      ctx.fillStyle = CODE_STROKE;
      ctx.textBaseline = "top";
      ctx.textAlign = "left";
      regions.forEach((r, i) => {
        const rx = x + targetW * r.left;
        const ry = y + targetH * r.top;
        const rw = targetW * r.width;
        const rh = targetH * r.height;
        ctx.strokeRect(rx, ry, rw, rh);
        if (r.name) ctx.fillText(r.name, rx + 2, ry + rh + 1);
        // Cache the primary (first) region for the dev drag hit-test.
        if (i === 0) _lastSetCodeRect = { x: rx, y: ry, w: rw, h: rh };
        // Draw the resize handle in dev mode.
        if (_devMode && i === 0) {
          ctx.save();
          ctx.setLineDash([]);
          ctx.fillStyle = CODE_STROKE;
          ctx.fillRect(rx + rw - HANDLE, ry + rh - HANDLE, HANDLE, HANDLE);
          ctx.restore();
        }
      });
    }

    // (#8 name-band overlay added in the next commit)

    ctx.restore();

    // Keep the dev interaction layer + toolbar in sync with dev state.
    if (_devMode) { _ensureDragLayer(); _ensureDevToolbar(); }
    else if (_dragLayer) { _removeDragLayer(); }
  }

  // ── Init: read dev pref + install hotkey once modules are present ───────────
  function _init() {
    _installHotkey();
    _devMode = _readDevPref();
    if (_devMode) { _ensureDevToolbar(); }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _init);
  } else {
    _init();
  }

  window.ScannerParts.overlay = {
    syncOverlaySize, drawOverlay, setGuide,
    setDevMode, isDevMode,   // v14: dev drag UI control
  };
})();
