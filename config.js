// config.js — v9.3
// v9.3: Updated SHEETS_SCRIPT_URL to the new Apps Script deployment
//       (the prior AKfycbxOj1-...XHIpwY deployment returned HTTP 404).
window.APP_CONFIG = {
  SHEETS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbzldsPIOgeU2HMlAd8zBSk3sjErQntCcyJ3tdeq69yrH2P2KDMKf1zyV68VbudQhzkjgA/exec",
  SECRET: "0104200206121997",
  AUTO_START_CAMERA: true,
  DEBUG_OPEN_DEFAULT: true,

  // ── Image-recognition backend (spike #56) ─────────────────────────────────
  // Server-side visual card recognition endpoint (see server/imageRecognition).
  // DISABLED by default: leave empty so production behavior is unchanged and the
  // scanner keeps using the existing text-only score. To enable the spike, point
  // this at a running backend, e.g. "http://127.0.0.1:8787/score".
  IMAGE_RECOGNITION_URL: ""
};

// ── v8.2 runtime tuning (paste into DevTools console to adjust live) ─────────
//
// Code-crop geometry (codeOcr.js):
//   window.ScannerParts.codeOcr.CODE_REGION.fromBottomFrac = 0.18;  // default
//   window.ScannerParts.codeOcr.CODE_REGION.heightFrac     = 0.10;
//   window.ScannerParts.codeOcr.CODE_REGION.widthFrac      = 0.65;
//
// Low-light thresholds (codeOcr.js — brightness/contrast of raw crop, 0–255):
//   window.ScannerParts.codeOcr.LOW_BRIGHTNESS_THRESHOLD = 55;
//   window.ScannerParts.codeOcr.LOW_CONTRAST_THRESHOLD   = 12;
//
// Image-assist backend hook (future):
//   window.ImageAssist.backendHook = async (dataUrl, candidates) => { ... };
