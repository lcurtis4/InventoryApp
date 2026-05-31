// js/ui/ocrPreview.js — EPIC-87 (Scanner UI polish)
//
// Owns visibility of the OCR preview (name-band crop) window.
//
//   • #89 (AC-004): preview hidden by default on load.
//   • #89 (AC-006): a "Show OCR Preview" toggle button reveals/hides it.
//   • #89 (AC-008): a new scan does NOT auto-pop the preview — visibility is
//                   only ever changed by explicit user action (Shift+D or the
//                   toggle button), so the panel stays hidden across scans.
//   • #88 (AC-005): Shift+D reveals the preview AND focuses the Manual Name box.
//   • #88 (AC-007): pressing Shift+D again (or the toggle) hides it.
//   • #88 (AC-009): Shift+D is ignored while the user is typing in a text input
//                   so it never hijacks a literal "D" keystroke.
(function () {
  const UI = (window.UI = window.UI || {});

  const SECTION_ID = "debugSection";
  const TOGGLE_ID  = "ocrPreviewToggleBtn";
  const NAME_ID    = "manualName";

  function $(id) { return document.getElementById(id); }

  function isVisible() {
    const sec = $(SECTION_ID);
    return !!sec && !sec.classList.contains("is-hidden");
  }

  function syncToggle() {
    const btn = $(TOGGLE_ID);
    if (!btn) return;
    const vis = isVisible();
    btn.setAttribute("aria-pressed", vis ? "true" : "false");
    btn.textContent = vis ? "Hide OCR Preview" : "Show OCR Preview";
  }

  function show() {
    const sec = $(SECTION_ID);
    if (!sec) return;
    sec.classList.remove("is-hidden");
    syncToggle();
  }

  function hide() {
    const sec = $(SECTION_ID);
    if (!sec) return;
    sec.classList.add("is-hidden");
    syncToggle();
  }

  function toggle() {
    if (isVisible()) hide();
    else show();
  }

  function onKeydown(e) {
    // Match Shift+D only (case-insensitive on the produced char). Ignore when
    // other modifiers are held so we don't clash with browser/OS shortcuts.
    const isShiftD =
      e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey &&
      (e.key === "D" || e.key === "d" || e.code === "KeyD");
    if (!isShiftD) return;

    // UAT round 2 — two fixes:
    //  (a) Registered in the CAPTURE phase (see init) so we intercept Shift+D
    //      BEFORE #manualName's own keydown handler runs. We stopImmediate-
    //      Propagation + preventDefault so the chord NEVER reaches the input
    //      as text and never triggers the input's pause-on-keydown. This is
    //      why the 2nd Shift+D previously "typed D" / stopped toggling.
    //  (b) Shift+D NO LONGER focuses the Manual Name box. Focusing it fired
    //      #manualName's focus -> Scanner.pause(), which paused scanning as a
    //      side effect. Shift+D is now a pure show/hide of the OCR preview and
    //      leaves scanning + focus untouched.
    e.preventDefault();
    e.stopImmediatePropagation();
    toggle();
  }

  function init() {
    // AC-004 / AC-008: ensure hidden default state and synced button label.
    // (HTML ships with .is-hidden; this is a defensive guarantee.)
    hide();

    // Pure show/hide toggle. Does NOT move focus (so it can't pause scanning).
    $(TOGGLE_ID)?.addEventListener("click", () => { toggle(); });

    // Capture phase: run before input-level keydown handlers (#manualName).
    document.addEventListener("keydown", onKeydown, true);
  }

  UI.ocrPreview = { init, show, hide, toggle, isVisible };
})();
