// js/ui/scan.js
(function(){
  "use strict";

  window.UI = window.UI || {};

  // ---- Safe helpers / fallbacks -------------------------------------------
  const $ = (window.UI.$) ? window.UI.$ : (id => document.getElementById(id));
  const status = (window.UI.status) ? window.UI.status : (el, msg/*, warn*/) => { if (el) el.textContent = msg || ""; };

  const names = window.UI.names || {};
  const N = (window.Lookup && (window.Lookup.normalize || window.LookupParts?.normalize)) || {};
  const sim = typeof N?.sim === "function" ? N.sim :
              (a,b) => (String(a).toLowerCase() === String(b).toLowerCase() ? 1 : 0);

  const State = window.UI.State || {};
  const resetFlowForNewPick = (window.UI && window.UI.resetFlowForNewPick) ? window.UI.resetFlowForNewPick : function(){};
  const enableQtyIfReady = (window.UI && window.UI.enableQtyIfReady) ? window.UI.enableQtyIfReady : function(){};

  const MIN_ACC = typeof State.MIN_ACCURACY === "number" ? State.MIN_ACCURACY : 80;

  // ---- Pause/Resume toggle helpers ----------------------------------------
  let isPaused = false;
  function setTogglePaused(paused){
    const btn = $("scanToggleBtn");
    if (!btn) return;
    isPaused = !!paused;
    btn.style.display = ""; // keep visible after camera starts
    btn.textContent = paused ? "Resume Scanning" : "Pause Scanning";
    btn.setAttribute("aria-pressed", paused ? "true" : "false");
    $("autoStatus").textContent = paused ? "Scanning paused." : "Scanner ready.";
  }

  // Keep compatibility with existing calls to UI.showResume(show)
  // show==true  -> want a "Resume" control visible (paused)
  // show==false -> running; show "Pause" control
  window.UI.showResume = function(show){
    setTogglePaused(!!show);
  };

  function computeAccuracy(fromText, toName) {
    if (typeof names.computeAccuracy === "function") return names.computeAccuracy(fromText, toName);
    try { return Math.round(sim(fromText || "", toName || "") * 100); }
    catch { return 0; }
  }

  // Clear all form fields / statuses (used when resuming)
  function clearFormAndState(){
    // Clear name fields
    const ocr = $("ocrName");    if (ocr) ocr.value = "";
    const man = $("manualName"); if (man) man.value = "";

    // Clear statuses
    const ls  = $("lookupStatus"); if (ls)  ls.textContent = "";
    status($("ocrStatus"), "");
    const ocf = $("ocrConf");     if (ocf) ocf.textContent = `accuracy: —`;

    // Reset selects
    const setSel = $("setSelect");     if (setSel) setSel.innerHTML = "";
    const rarSel = $("raritySelect");  if (rarSel) rarSel.innerHTML = "";
    const cond   = $("conditionSelect"); if (cond) cond.value = "";

    // Reset qty/button flow via shared helpers
    resetFlowForNewPick();
    enableQtyIfReady();

    // Clear selection state
    if (State) {
      State.selectedCard = null;
      State.selectedSetName = null;
      State.selectedRarity = null;
      State.selectedPrinting = null;
      State.selectedCondition = null;
    }
  }

  // ---- Bind UI actions -----------------------------------------------------
  function bind(){
    // Start & monitor
    $("startBtn")?.addEventListener("click", async () => {
      if (!window.Scanner) {
        console.error("Scanner API not available");
        status($("camStatus"), "Scanner not ready (check core.js/camera.js load).", true);
        return;
      }

      try {
        status($("camStatus"), "Starting camera…");
        await window.Scanner.start();
        status($("camStatus"), "Camera running.");
      } catch (e) {
        console.error(e);
        status($("camStatus"), "Could not start camera.", true);
        return;
      }

      // Show toggle in "Pause" state (we are running)
      setTogglePaused(false);

      // Begin monitor loop
      window.Scanner.startMonitor(
        // onFound(best)
        async (best) => {
          $("ocrConf").textContent = `accuracy: …`;
          if (window.Scanner.setDebugAccuracy) window.Scanner.setDebugAccuracy(null);
          status($("ocrStatus"), `OCR text captured — see Debug preview`);

          try {
            const scannedText = (best && best.text) ? String(best.text).trim() : "";
            let canonical = "";
            if (typeof window.Lookup?.resolveNameFromScanNgrams === "function") {
              canonical = await window.Lookup.resolveNameFromScanNgrams(scannedText);
            } else {
              // Resolver not loaded or disabled → don’t lock on raw OCR
              canonical = "";
              console.debug("[scan] resolver unavailable, skipping lock");
            }

            if (canonical) {
              // Compute / show accuracy (fallbacks supported)
              const acc = computeAccuracy(scannedText, canonical);
              $("ocrConf").textContent = `accuracy: ${isFinite(acc) ? acc : 0}%`;
              if (window.Scanner.setDebugAccuracy) window.Scanner.setDebugAccuracy(acc);

              // Populate name field
              $("ocrName").value = canonical;

              // Pause immediately on match
              try { window.Scanner.pause(); } catch (_) {}
              window.UI.showResume(true); // switch toggle to "Resume"
              const lockMsg = isFinite(acc) ? `Locked on: ${canonical} (accuracy ${acc}%)` : `Locked on: ${canonical}`;
              status($("ocrStatus"), lockMsg);
              $("autoStatus").textContent = `Locked on: ${canonical}. Scanning paused.`;

              // === AUTO-TRIGGER LOOKUP when accuracy is decent ===
              if (acc >= MIN_ACC || acc >= 65) {
                $("lookupBtn")?.click();
              }
            } else {
              // No match (keep camera live; do NOT pause)
              $("ocrConf").textContent = `accuracy: 0%`;
              if (window.Scanner.setDebugAccuracy) window.Scanner.setDebugAccuracy(0);
              status($("ocrStatus"), `No DB match found — keeping camera live…`, true);
            }
          } catch (e) {
            console.error(e);
            status($("ocrStatus"), `Lookup error; will keep trying…`, true);
          }
        },

        // onState(state, ms, meta)
        (state, ms, meta) => {
          const r = Math.max(0, Math.ceil((3000 - ms) / 1000));
          const auto = $("autoStatus");
          switch (state) {
            case "paused":   auto.textContent = `Scanning paused.`; break;
            case "steady":   auto.textContent = `Looks good. Scanning soon… (${r}s)`; break;
            case "moving":   auto.textContent = `Hold steady…`; break;
            case "lowlight": auto.textContent = meta && meta.note === "empty-band" ? `Band empty.` : `Low contrast.`; break;
            case "scanning": auto.textContent = `OCR in progress…`; break;
            default:         auto.textContent = `Waiting for steady card…`;
          }
        }
      );
    });

    // Toggle button — Pause <-> Resume
    $("scanToggleBtn")?.addEventListener("click", () => {
      if (!window.Scanner) return;

      if (isPaused) {
        // RESUME: clear form, resume scanner, flip button to "Pause"
        $("autoStatus").textContent = `Resuming scanning…`;
        clearFormAndState();
        try { window.Scanner.resume(); } catch (_) {}
        setTogglePaused(false);
      } else {
        // PAUSE: just pause scanner, flip button to "Resume"
        try { window.Scanner.pause(); } catch (_) {}
        setTogglePaused(true);
      }
    });

    // Autocomplete attach → pause & apply selection
    (function () {
      const input = $("manualName");
      if (input && window.Autocomplete && typeof window.Autocomplete.attach === "function") {
        window.Autocomplete.attach(input, (name) => {
          try { window.Scanner.pause(); } catch (_) {}
          window.UI.showResume(true); // switch toggle to "Resume"
          $("autoStatus").textContent = "Scanning paused (name selected)…";
          $("ocrName").value = name || "";
          // optional: $("lookupBtn")?.click();
        });
      }
    })();

    // Pause when user starts typing manually
    (function () {
      const input = $("manualName"); if (!input) return;
      const pauseNow = () => {
        try { window.Scanner.pause(); } catch (_) {}
        window.UI.showResume(true); // switch toggle to "Resume"
        $("autoStatus").textContent = "Scanning paused (manual typing)…";
      };
      input.addEventListener("input", pauseNow);
      input.addEventListener("keydown", pauseNow);
      input.addEventListener("focus", pauseNow);
    })();
  }

  window.UI.scan = { bind };
})();
