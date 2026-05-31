// js/ui/cue.js — EPIC-93, Story #97
//
// Provides synthesized Web Audio next-step cues + highlight helpers.
// Implements AC-004, AC-005, AC-006.
//
// Two cue types:
//   "needs-input"  — played/shown when a field still needs the user's attention.
//                    Short, lower-pitched tone. Amber highlight on the field.
//   "ready"        — played/shown when the card is fully ready to confirm.
//                    Brighter, rising tone. Green "ready" highlight on the form.
//
// Web Audio rules:
//   - AudioContext is created lazily on the FIRST user gesture so the browser
//     doesn't block playback with an autoplay policy violation.
//   - We patch `window.UI.cue.primeAudio()` onto common user-gesture events
//     (Start Camera click, captureConfirmBtn click, first keydown) so the
//     context is resumed before the first cue fires.
//   - `prefers-reduced-motion` suppresses audio. The highlight helpers still
//     run because they are purely visual and do not cause motion.
//   - A mute flag is available at `window.UI.cue.muted = true` for callers
//     that want to suppress all audio (AC-006).
//
// Exported surface (on window.UI.cue):
//   .fireNeedsInput(fieldEl)   — highlight field + play needs-input tone once.
//   .fireReady()               — highlight form ready + play ready tone once.
//   .clearCues()               — remove all cue classes (call on reset/close).
//   .primeAudio()              — must be called inside a user gesture to satisfy
//                                the browser's autoplay policy. Called
//                                automatically from the gesture listeners below.
//   .muted                     — boolean; set true to suppress all audio.

(function () {
  "use strict";

  window.UI = window.UI || {};

  // ── Internal state ────────────────────────────────────────────────────────────
  let _ctx = null;          // AudioContext (created once, lazily)
  let _primed = false;      // true once AudioContext.resume() has been called

  // ── Mute / reduced-motion guards ─────────────────────────────────────────────
  function _isAudioSuppressed() {
    if (cue.muted) return true;
    // Respect prefers-reduced-motion: no audio if the user has asked for less
    // motion/stimulation. AC-006.
    try {
      if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        return true;
      }
    } catch (_) {}
    return false;
  }

  // ── AudioContext helper ───────────────────────────────────────────────────────
  function _getCtx() {
    if (!_ctx) {
      try {
        _ctx = new (window.AudioContext || window.webkitAudioContext)();
      } catch (_) {
        return null;
      }
    }
    return _ctx;
  }

  function primeAudio() {
    const ctx = _getCtx();
    if (!ctx || _primed) return;
    try {
      ctx.resume().then(() => { _primed = true; }).catch(() => {});
    } catch (_) {}
  }

  // ── Tone synthesizer ──────────────────────────────────────────────────────────
  // Synthesizes a short envelope using a single OscillatorNode + GainNode.
  // No asset files — fully offline-safe. AC-006.
  //
  // opts: { freq: number, freq2?: number, duration: ms, type: OscillatorType,
  //         attack: ms, release: ms, gain: 0..1 }
  function _playTone(opts) {
    if (_isAudioSuppressed()) return;
    const ctx = _getCtx();
    if (!ctx) return;

    const now = ctx.currentTime;
    const dur  = (opts.duration || 120) / 1000;
    const atk  = (opts.attack   ||  10) / 1000;
    const rel  = (opts.release  ||  60) / 1000;
    const peak = opts.gain !== undefined ? opts.gain : 0.18;

    try {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = opts.type || "sine";
      osc.frequency.setValueAtTime(opts.freq || 440, now);
      // Optional pitch glide (for the "ready" rising tone)
      if (opts.freq2) {
        osc.frequency.linearRampToValueAtTime(opts.freq2, now + dur * 0.8);
      }

      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(peak, now + atk);
      gain.gain.setValueAtTime(peak, now + dur - rel);
      gain.gain.linearRampToValueAtTime(0, now + dur);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + dur + 0.01);

      // Let GC clean up after playback
      osc.onended = () => { try { osc.disconnect(); gain.disconnect(); } catch (_) {} };
    } catch (_) {}
  }

  // ── Needs-input tone (AC-004) ─────────────────────────────────────────────────
  // Soft, slightly lower-pitched double-blip — attention without alarm.
  function _playNeedsInputTone() {
    _playTone({ freq: 520, duration: 80, type: "sine", attack: 8, release: 40, gain: 0.14 });
    setTimeout(() => {
      _playTone({ freq: 480, duration: 80, type: "sine", attack: 8, release: 40, gain: 0.10 });
    }, 110);
  }

  // ── Ready tone (AC-005) ───────────────────────────────────────────────────────
  // Brighter, rising two-note chime — "all set, go confirm".
  function _playReadyTone() {
    _playTone({ freq: 600, freq2: 780, duration: 140, type: "triangle", attack: 12, release: 70, gain: 0.18 });
  }

  // ── CSS cue class helpers ─────────────────────────────────────────────────────
  // .cue-needs-input — amber ring on a specific field (AC-004)
  // .cue-ready       — green ring on the confirm button / form (AC-005)
  const CUE_NEEDS  = "cue-needs-input";
  const CUE_READY  = "cue-ready";
  const CUE_FORM   = "cue-form-ready";

  function clearCues() {
    document.querySelectorAll("." + CUE_NEEDS).forEach(el => el.classList.remove(CUE_NEEDS));
    document.querySelectorAll("." + CUE_READY).forEach(el => el.classList.remove(CUE_READY));
    document.querySelectorAll("." + CUE_FORM).forEach(el => el.classList.remove(CUE_FORM));
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  /**
   * Highlight a specific field + play the needs-input tone once (AC-004).
   * @param {Element|null} fieldEl  — the DOM element to highlight (optional)
   */
  function fireNeedsInput(fieldEl) {
    clearCues();
    if (fieldEl) {
      fieldEl.classList.add(CUE_NEEDS);
      // Auto-clear on interaction
      const off = () => { fieldEl.classList.remove(CUE_NEEDS); fieldEl.removeEventListener("change", off); fieldEl.removeEventListener("input", off); };
      fieldEl.addEventListener("change", off, { once: true });
      fieldEl.addEventListener("input",  off, { once: true });
    }
    _playNeedsInputTone();
  }

  /**
   * Signal card-ready state: highlight the confirm button + play ready tone (AC-005).
   */
  function fireReady() {
    clearCues();
    const btn = document.getElementById("confirmBtn");
    if (btn) {
      btn.classList.add(CUE_READY);
      btn.addEventListener("click", () => btn.classList.remove(CUE_READY), { once: true });
    }
    // Also mark the overall form section so themes can add a subtle glow
    const formEl = document.querySelector(".form-section") || document.getElementById("cardForm");
    if (formEl) formEl.classList.add(CUE_FORM);
    _playReadyTone();
  }

  // ── Auto-prime on common user gestures ────────────────────────────────────────
  // Must happen inside a real user gesture event handler (AC-006 / autoplay).
  function _bindPrimeListeners() {
    const targets = ["startBtn", "confirmBtn", "captureConfirmBtn", "codeLookupBtn"];
    targets.forEach(id => {
      document.getElementById(id)?.addEventListener("click", primeAudio, { once: true });
    });
    document.addEventListener("keydown", primeAudio, { once: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _bindPrimeListeners);
  } else {
    _bindPrimeListeners();
  }

  // ── Export ────────────────────────────────────────────────────────────────────
  const cue = {
    fireNeedsInput,
    fireReady,
    clearCues,
    primeAudio,
    muted: false,
  };
  window.UI.cue = cue;
})();
