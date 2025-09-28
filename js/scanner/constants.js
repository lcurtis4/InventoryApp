(function(){
  window.ScannerParts = window.ScannerParts || {};
  /* ===== Tunables ===== */

  // Keep the loop responsive but not too heavy
  const SAMPLE_INTERVAL_MS = 500;   // was 160
  const STABLE_WINDOW_MS   = 350;

  // Motion / contrast gates
  const MOVEMENT_THRESHOLD = 12.0;  // was 9.0
  const MIN_CONTRAST       = 6;   // was 8.0

  // 🔼 Move scan window UP toward the title strip (green box)
  const VERT_SEARCH_TOP_PCT = 0.14; // start ~10% down from the top
  const VERT_SEARCH_MAX_PCT = 0.24; // stop ~24% down

  // Horizontal insets (kept)
  const HORIZ_INSET_PCT     = 0.165;

  // Thinner bands favor the title row; fewer vertical steps for perf
  const BAND_HEIGHT_FACTORS = [0.055, 0.065, 0.075]; // was [0.10, 0.11, 0.12]
  const VERT_STEP_PCT       = 0.018;                 // was 0.008 / 0.020

  // Make “too empty” gate reasonable so OCR triggers
  const MIN_BAND_ENERGY     = 0.35;  // was 0.85

  // Trim heuristics (slightly gentler than before)
  const TRIM_LOW_COL_FACTOR = 0.35;  // was 0.40
  const TRIM_ROW_FACTOR     = 0.28;  // was 0.30
  const TRIM_MIN_WIDTH_PCT  = 0.55;  // was 0.65
  const TRIM_MIN_HEIGHT_PCT = 0.50;  // was 0.60

  // Horizontal nudges (your prior tuning)
  const HORIZ_OFFSET_PX = 35;
  const EXTRA_LEFT_PX   = 72;

  // Used by overlay helpers
  const CARD_ASPECT_WH = 59/86;

  window.ScannerParts.CONST = {
    SAMPLE_INTERVAL_MS, STABLE_WINDOW_MS, MOVEMENT_THRESHOLD, MIN_CONTRAST,
    VERT_SEARCH_TOP_PCT, VERT_SEARCH_MAX_PCT, HORIZ_INSET_PCT,
    BAND_HEIGHT_FACTORS, VERT_STEP_PCT,
    MIN_BAND_ENERGY, TRIM_LOW_COL_FACTOR, TRIM_ROW_FACTOR,
    TRIM_MIN_WIDTH_PCT, TRIM_MIN_HEIGHT_PCT,
    HORIZ_OFFSET_PX, EXTRA_LEFT_PX,
    CARD_ASPECT_WH
  };
})();
