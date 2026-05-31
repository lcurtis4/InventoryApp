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

    // AC-009 (revised): Shift+D is a deliberate app shortcut, so it ALWAYS
    //   toggles — even when focus is in the Manual Name box (which it is right
    //   after the first Shift+D focuses it). Previously we bailed out when a
    //   text input was focused, which made the *second* Shift+D type a literal
    //   "D" into the field instead of closing the preview. We preventDefault on
    //   every Shift+D so the chord never reaches an input as text. (A bare "d"
    //   has no Shift and never matches here, so normal typing is unaffected.)
    e.preventDefault();

    // AC-007: Shift+D toggles. AC-005: when revealing, focus the name box.
    if (isVisible()) {
      hide();
      // Return focus out of the name box so a follow-up keystroke isn't typed
      // into it; only blur if the name box currently holds focus.
      const nameEl = $(NAME_ID);
      if (nameEl && document.activeElement === nameEl) nameEl.blur();
    } else {
      show();
      const nameEl = $(NAME_ID);
      if (nameEl) { nameEl.focus(); nameEl.select?.(); }
    }
  }

  function init() {
    // AC-004 / AC-008: ensure hidden default state and synced button label.
    // (HTML ships with .is-hidden; this is a defensive guarantee.)
    hide();

    $(TOGGLE_ID)?.addEventListener("click", () => {
      toggle();
      // AC-005 parity: revealing via the button also focuses the name box.
      if (isVisible()) $(NAME_ID)?.focus();
    });

    document.addEventListener("keydown", onKeydown);
  }

  UI.ocrPreview = { init, show, hide, toggle, isVisible };
})();
