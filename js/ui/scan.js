// js/ui/scan.js  — v10.1
// v10.1 changes:
//   • Listens for `inventory:form:reset` (dispatched by confirm.js after a
//     successful Post to Sheet). On reset we now:
//        1. Pause the scanner so it doesn't immediately re-detect the same
//           card sitting on the workbench and re-show the Accept bar.
//        2. Call clearFormAndState() which clears the Scanned Name input,
//           hides the capture-confirm bar / candidates picker, wipes State,
//           and resets the match-source bar.
//        3. Flip the Pause/Resume button to "Resume Scanning" so the user
//           can explicitly start the next card.
//
// v8.2 (preserved):
// Changes vs v8.1:
//   1. captureConfirmBtn no longer force-enables #confirmBtn before condition is chosen.
//      Previously: if code path had set/rarity, btn.disabled = false unconditionally.
//      Now: always delegates to enableQtyIfReady() so the standard guard applies.
//   2. setMatchSource() updates #matchSourceBar with how the suggestion was derived:
//      "exact-code", "code-unresolved", "name-fallback", or "manual-code".
//   3. applyNeedsInput() marks #setSelect, #raritySelect, #conditionSelect, #qty
//      with .needs-input when they still need attention after a code match.
//      Highlights are removed as each field is filled (via change/input events).
//   4. No other logic changes — same OCR paths, same candidate picker, same posting.
(function(){
  "use strict";

  window.UI = window.UI || {};

  const $ = window.UI.$ || ((id) => document.getElementById(id));
  const status = window.UI.status || ((el, msg) => { if (el) el.textContent = msg || ""; });

  const names = window.UI.names || {};
  const N  = (window.Lookup && (window.Lookup.normalize || window.LookupParts?.normalize)) || {};
  const sim = typeof N?.sim === "function" ? N.sim
            : (a, b) => (String(a).toLowerCase() === String(b).toLowerCase() ? 1 : 0);

  const State               = window.UI.State               || {};
  const resetFlowForNewPick = window.UI.resetFlowForNewPick  || function(){};
  const enableQtyIfReady    = window.UI.enableQtyIfReady     || function(){};

  const MIN_ACC = typeof State.MIN_ACCURACY === "number" ? State.MIN_ACCURACY : 80;

  // ── Pause/Resume toggle ───────────────────────────────────────────────────────
  let isPaused = false;
  function setTogglePaused(paused) {
    const btn = $("scanToggleBtn");
    if (!btn) return;
    isPaused = !!paused;
    btn.style.display = "";
    btn.textContent = paused ? "Resume Scanning" : "Pause Scanning";
    btn.setAttribute("aria-pressed", paused ? "true" : "false");
    $("autoStatus").textContent = paused ? "Scanning paused." : "Scanner ready.";
  }
  window.UI.showResume = function(show) { setTogglePaused(!!show); };

  function setAutoStatus(msg) {
    const el = $("autoStatus");
    if (el) el.textContent = msg;
  }

  // ── Match-source status bar (v8.2) ────────────────────────────────────────────
  // mode: "exact-code" | "code-unresolved" | "name-fallback" | "manual-code" | ""
  function setMatchSource(mode, detail) {
    const bar   = $("matchSourceBar");
    const label = $("matchSourceLabel");
    const icon  = $("matchSourceIcon");
    if (!bar || !label) return;

    const labels = {
      "exact-code":       "✔ Exact set-code match",
      "code-unresolved":  "⚠ Code scanned but not resolved — using name fallback",
      "name-fallback":    "⚠ Name fallback (no code read)",
      "manual-code":      "✔ Manual code lookup",
      "":                 "",
    };
    const icons = {
      "exact-code":      "●",
      "code-unresolved": "●",
      "name-fallback":   "●",
      "manual-code":     "●",
      "":                "●",
    };

    bar.style.display = mode ? "" : "none";
    bar.setAttribute("data-mode", mode || "");
    if (label) label.textContent = (labels[mode] || mode) + (detail ? ` — ${detail}` : "");
    if (icon)  icon.textContent  = icons[mode] || "●";
  }
  window.UI.setMatchSource = setMatchSource;

  // ── .needs-input highlight helpers (v8.2) ────────────────────────────────────
  // Adds amber border to fields still needing input after a code-confirmed match.
  // Required: set, rarity, condition, qty.
  // Fields prefilled by code should NOT be highlighted.
  function applyNeedsInput(opts) {
    // opts: { set: bool, rarity: bool, condition: bool, qty: bool }
    const ids = { setSelect: opts.set, raritySelect: opts.rarity, conditionSelect: opts.condition, qty: opts.qty };
    for (const [id, needs] of Object.entries(ids)) {
      const el = $(id);
      if (!el) continue;
      if (needs) el.classList.add("needs-input");
      else       el.classList.remove("needs-input");
    }
  }

  function clearNeedsInput() {
    document.querySelectorAll(".needs-input").forEach(el => el.classList.remove("needs-input"));
  }

  // Wire up removal of .needs-input as fields are filled
  window.addEventListener("DOMContentLoaded", function() {
    $("setSelect")?.addEventListener("change", function() {
      if (this.value) this.classList.remove("needs-input");
    });
    $("raritySelect")?.addEventListener("change", function() {
      if (this.value) this.classList.remove("needs-input");
    });
    $("conditionSelect")?.addEventListener("change", function() {
      if (this.value) this.classList.remove("needs-input");
    });
    $("qty")?.addEventListener("input", function() {
      const v = parseInt(this.value, 10);
      if (v >= 1) this.classList.remove("needs-input");
    });
  });

  // ── Capture confirm bar ───────────────────────────────────────────────────────
  function showCaptureConfirmBar(name, extra) {
    const bar   = $("captureConfirmBar");
    const label = $("captureConfirmLabel");
    if (!bar) return;
    if (label) {
      const extraStr = extra ? ` — ${extra}` : "";
      label.textContent = `Accept: "${name}"${extraStr}?`;
    }
    bar.style.display = "";
    hideCandidatesPicker();
  }
  function hideCaptureConfirmBar() {
    const bar = $("captureConfirmBar");
    if (bar) bar.style.display = "none";
  }

  // ── Candidates picker ─────────────────────────────────────────────────────────
  function getCandidatesPicker() { return $("candidatesPicker"); }
  function hideCandidatesPicker() {
    const el = getCandidatesPicker();
    if (el) el.style.display = "none";
  }

  function makeCandCard(c, scannedCode, onPick) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "cand-card";
    card.setAttribute("aria-label", `Select ${c.name}`);

    const imgUrl = c.imageUrl || (c.id ? `https://images.ygoprodeck.com/images/cards_small/${c.id}.jpg` : null);
    if (imgUrl) {
      const img = document.createElement("img");
      img.src = imgUrl; img.alt = c.name; img.className = "cand-img"; img.loading = "lazy";
      img.onerror = function() { this.style.display = "none"; };
      card.appendChild(img);
    }

    const nameEl = document.createElement("div");
    nameEl.className = "cand-name"; nameEl.textContent = c.name;
    card.appendChild(nameEl);

    if (c.set_code || c.set_rarity || c.set_name) {
      const meta = document.createElement("div");
      meta.className = "cand-meta";
      meta.textContent = [c.set_code, c.set_rarity, c.set_name].filter(Boolean).join(" · ");
      card.appendChild(meta);
    }

    const confRow = document.createElement("div");
    confRow.className = "cand-conf-row";

    const textPct = Math.round(Math.min(1, c.score || 0) * 100);
    const confEl = document.createElement("span");
    confEl.className = "cand-conf"; confEl.textContent = `${textPct}% text`;
    confRow.appendChild(confEl);

    if (typeof c.imgScore === "number") {
      const visEl = document.createElement("span");
      visEl.className = "cand-vis"; visEl.textContent = `${Math.round(c.imgScore * 100)}% visual`;
      confRow.appendChild(visEl);
    }

    if (c.exactMatch || (scannedCode && c.set_code === scannedCode)) {
      const badge = document.createElement("span");
      badge.className = "cand-exact-badge"; badge.textContent = "exact code";
      confRow.appendChild(badge);
    }
    card.appendChild(confRow);

    card.addEventListener("click", () => {
      hideCandidatesPicker(); hideCaptureConfirmBar();
      if (typeof onPick === "function") onPick(c);
    });
    return card;
  }

  function showCandidatesPicker(candidates, scannedCode, onPick, onRescan) {
    const picker = getCandidatesPicker();
    if (!picker) return;
    picker.innerHTML = "";

    const header = document.createElement("div");
    header.className = "cand-header";
    header.textContent = scannedCode ? `Code "${scannedCode}" — choose printing:` : "Choose matching card:";
    picker.appendChild(header);

    const hasVis = candidates.some(c => typeof c.imgScore === "number");
    if (hasVis) {
      const visNote = document.createElement("div");
      visNote.className = "cand-vis-note";
      visNote.textContent = "Visual similarity scored against card art (browser-only, 32×32 crop).";
      picker.appendChild(visNote);
    }

    const list = document.createElement("div");
    list.className = "cand-list";
    candidates.forEach(c => list.appendChild(makeCandCard(c, scannedCode, (picked) => { onPick && onPick(picked); })));
    picker.appendChild(list);

    const footer = document.createElement("div");
    footer.className = "cand-footer";
    const rescanBtn = document.createElement("button");
    rescanBtn.type = "button"; rescanBtn.className = "secondary cand-rescan"; rescanBtn.textContent = "Rescan";
    rescanBtn.addEventListener("click", () => { hideCandidatesPicker(); hideCaptureConfirmBar(); onRescan && onRescan(); });
    footer.appendChild(rescanBtn);
    picker.appendChild(footer);
    picker.style.display = "";
  }

  // ── Apply a code-resolved candidate directly to the form ──────────────────────
  function applyCodeCandidate(cand, scannedCode) {
    const name = cand.name || "";
    $("ocrName").value = name;

    const codeInput = $("manualCode");
    if (codeInput && (cand.set_code || scannedCode)) {
      codeInput.value = cand.set_code || scannedCode || "";
    }

    State.selectedCard     = { name, id: cand.id, sets: [] };
    State.selectedSetName  = cand.set_name   || null;
    State.selectedRarity   = cand.set_rarity || null;
    State.selectedPrinting = cand;

    const setSel = $("setSelect");
    if (setSel && cand.set_name) {
      setSel.innerHTML = "";
      const opt = document.createElement("option");
      opt.value = cand.set_name;
      opt.textContent = cand.set_name + (cand.set_code ? ` (${cand.set_code})` : "");
      setSel.appendChild(opt);
      setSel.value = cand.set_name;
      setSel.classList.remove("needs-input");
    }

    const rarSel = $("raritySelect");
    if (rarSel && cand.set_rarity) {
      rarSel.innerHTML = "";
      const opt = document.createElement("option");
      opt.value = cand.set_rarity; opt.textContent = cand.set_rarity;
      rarSel.appendChild(opt);
      rarSel.value = cand.set_rarity;
      rarSel.classList.remove("needs-input");
    }

    status($("ocrStatus"), `Code match: ${cand.set_code || scannedCode} → ${name}`);
    $("ocrConf").textContent = `code: exact`;

    // v8.2: highlight fields still needing input (set/rarity already filled by code)
    const condFilled = !!(State.selectedCondition || ($("conditionSelect")?.value));
    const qtyVal     = parseInt($("qty")?.value || "0", 10);
    applyNeedsInput({
      set:       false,          // prefilled by code
      rarity:    false,          // prefilled by code
      condition: !condFilled,
      qty:       !(qtyVal >= 1),
    });

    enableQtyIfReady();
  }

  // ── Apply a name-path candidate ────────────────────────────────────────────────
  function applyPickedName(name, scannedText) {
    const acc = scannedText ? computeAccuracy(scannedText, name) : 0;
    $("ocrConf").textContent = `accuracy: ${isFinite(acc) ? acc : 0}%`;
    if (window.Scanner?.setDebugAccuracy) window.Scanner.setDebugAccuracy(acc);
    $("ocrName").value = name;
    try { window.Scanner.pause(); } catch (_) {}
    window.UI.showResume(true);
    status($("ocrStatus"), `Locked: ${name}${acc ? ` (${acc}%)` : ""}`);
    setAutoStatus(`Locked on: ${name}. Confirm or rescan.`);
    $("lookupBtn")?.click();
  }

  // ── Clear form ─────────────────────────────────────────────────────────────────
  function clearFormAndState() {
    const ocr = $("ocrName");    if (ocr) ocr.value = "";
    const man = $("manualName"); if (man) man.value = "";
    const mc  = $("manualCode"); if (mc)  mc.value  = "";

    hideCaptureConfirmBar();
    hideCandidatesPicker();
    clearNeedsInput();
    setMatchSource("");

    const ls = $("lookupStatus"); if (ls) ls.textContent = "";
    status($("ocrStatus"), "");
    const ocf = $("ocrConf"); if (ocf) ocf.textContent = "accuracy: —";

    const setSel  = $("setSelect");    if (setSel)  setSel.innerHTML  = "";
    const rarSel  = $("raritySelect"); if (rarSel)  rarSel.innerHTML  = "";
    const cond    = $("conditionSelect"); if (cond) cond.value = "";

    resetFlowForNewPick();
    enableQtyIfReady();

    if (State) {
      State.selectedCard     = null;
      State.selectedSetName  = null;
      State.selectedRarity   = null;
      State.selectedPrinting = null;
      State.selectedCondition = null;
    }
  }

  // ── Rescan ─────────────────────────────────────────────────────────────────────
  function doRescan() {
    $("ocrName").value = "";
    status($("ocrStatus"), "");
    $("ocrConf").textContent = "accuracy: —";
    clearNeedsInput();
    setMatchSource("");
    setAutoStatus("Resuming scan…");
    try { window.Scanner.resume(); } catch (_) {}
    setTogglePaused(false);
  }

  function computeAccuracy(fromText, toName) {
    if (typeof names.computeAccuracy === "function") return names.computeAccuracy(fromText, toName);
    try { return Math.round(sim(fromText || "", toName || "") * 100); } catch { return 0; }
  }

  // ── Manual code lookup ─────────────────────────────────────────────────────────
  async function doManualCodeLookup(rawCode) {
    const cs = window.Lookup?.codeSearch || window.LookupParts?.codeSearch;
    if (!cs) { status($("lookupStatus"), "Code search not available.", true); return; }

    const code = (rawCode || "").trim().toUpperCase();
    if (!code) { status($("lookupStatus"), "Enter a set code (e.g. MP25-EN120).", true); return; }

    status($("lookupStatus"), `Looking up code ${code}…`);
    try { window.Scanner.pause(); } catch (_) {}
    window.UI.showResume(true);
    resetFlowForNewPick();
    clearNeedsInput();

    try {
      const res = await cs.resolveCode(code);
      if (!res || !res.candidates?.length) {
        status($("lookupStatus"), `No match for code "${code}". Try a card name instead.`, true);
        setMatchSource("code-unresolved", code);
        return;
      }

      let candidates = res.candidates.map(c => ({ ...c, score: 1.0 }));
      const ia = window.ScannerParts?.imageAssist || window.ImageAssist;
      if (ia?.scoreVisually) {
        try {
          const v = document.getElementById("video");
          if (v && v.videoWidth) {
            const wc = document.getElementById("workCanvas") || document.createElement("canvas");
            wc.width = v.videoWidth; wc.height = v.videoHeight;
            wc.getContext("2d").drawImage(v, 0, 0);
            candidates = await ia.scoreVisually(candidates, wc);
          }
        } catch (_) {}
      }

      if (candidates.length === 1) {
        applyCodeCandidate(candidates[0], code);
        setMatchSource("manual-code", code);
        showCaptureConfirmBar(candidates[0].name, candidates[0].set_code || code);
      } else {
        status($("lookupStatus"), `${candidates.length} printings found for ${code}.`);
        setAutoStatus("Multiple printings — choose one below.");
        showCandidatesPicker(candidates, code, (picked) => {
          applyCodeCandidate(picked, code);
          setMatchSource("manual-code", picked.set_code || code);
          showCaptureConfirmBar(picked.name, picked.set_code || code);
        }, doRescan);
      }
    } catch (e) {
      console.error("[scan] manual code lookup failed:", e);
      status($("lookupStatus"), "Code lookup failed. Check console.", true);
    }
  }
  // Expose so lookup.js can delegate to it
  window.UI.scan = window.UI.scan || {};
  window.UI.scan.doManualCodeLookup = doManualCodeLookup;

  // ── Handle result from core.js performScan ─────────────────────────────────────
  async function handleScanResult(result) {
    $("ocrConf").textContent = "accuracy: …";
    if (window.Scanner?.setDebugAccuracy) window.Scanner.setDebugAccuracy(null);

    const { codes, candidates, scanMode, text: scannedText } = result;

    if (scanMode === "code") {
      status($("ocrStatus"), codes.length
        ? `Found code${codes.length > 1 ? "s" : ""}: ${codes.join(", ")}`
        : "Code OCR ran — no valid code pattern found.");
    } else if (scanMode === "name") {
      status($("ocrStatus"), scannedText ? `Name OCR fallback: "${scannedText}"` : "Name OCR fallback: no text.");
    } else {
      status($("ocrStatus"), "No code or name found. Hold card steady.", true);
      $("ocrConf").textContent = "accuracy: 0%";
      if (window.Scanner?.setDebugAccuracy) window.Scanner.setDebugAccuracy(0);
      return;
    }

    if (!candidates || !candidates.length) {
      $("ocrConf").textContent = "accuracy: 0%";
      if (window.Scanner?.setDebugAccuracy) window.Scanner.setDebugAccuracy(0);
      if (scanMode === "code" && codes.length > 0) {
        setMatchSource("code-unresolved", codes[0]);
      }
      status($("ocrStatus"),
        scanMode === "code"
          ? `Code "${codes[0] || ""}" not found in DB — trying name…`
          : "No DB match — keeping camera live.", true);
      return;
    }

    try { window.Scanner.pause(); } catch (_) {}
    window.UI.showResume(true);

    const best = candidates[0];
    const primaryCode = codes[0] || null;

    if (scanMode === "code" && best.exactMatch) {
      $("ocrConf").textContent = "code: exact";
      if (window.Scanner?.setDebugAccuracy) window.Scanner.setDebugAccuracy(100);
    } else {
      const acc = scannedText ? computeAccuracy(scannedText, best.name) : Math.round((best.score || 0) * 100);
      $("ocrConf").textContent = `accuracy: ${acc}%`;
      if (window.Scanner?.setDebugAccuracy) window.Scanner.setDebugAccuracy(acc);
    }

    // Update match-source bar
    if (scanMode === "code") {
      setMatchSource("exact-code", primaryCode || codes.join("/"));
    } else {
      setMatchSource("name-fallback", scannedText || "");
    }

    // Single confident match → populate directly
    if (candidates.length === 1 && (best.exactMatch || (best.score || 0) >= 0.90)) {
      applyCodeCandidate(best, primaryCode);
      const label = best.set_code ? `${best.set_code} · ${best.set_rarity || "?"}` : (best.set_rarity || "");
      setAutoStatus(`Found: ${best.name}. Choose condition + qty, then confirm.`);
      showCaptureConfirmBar(best.name, label || null);
      return;
    }

    // Multiple candidates → picker
    const modeLabel = scanMode === "code"
      ? `Code "${primaryCode || codes.join("/")}" — ${candidates.length} printing(s):`
      : `${candidates.length} match(es) — choose:`;
    setAutoStatus(modeLabel);

    hideCaptureConfirmBar();
    showCandidatesPicker(candidates, primaryCode, (picked) => {
      applyCodeCandidate(picked, primaryCode || picked.set_code || "");
      if (scanMode === "code") setMatchSource("exact-code", picked.set_code || primaryCode);
      else setMatchSource("name-fallback", scannedText || "");
      showCaptureConfirmBar(picked.name, picked.set_code ? `${picked.set_code} · ${picked.set_rarity || ""}` : null);
    }, doRescan);
  }

  // ── Bind UI actions ────────────────────────────────────────────────────────────
  function bind() {
    // v10.1: post-success reset. Pause the scanner + clear everything so the
    //        camera doesn't immediately re-fire on the same card.
    document.addEventListener("inventory:form:reset", () => {
      try { window.Scanner?.pause?.(); } catch (_) {}
      setTogglePaused(true);
      // CONSOLE-OFF v12 try { clearFormAndState(); } catch (e) { console.warn("[scan] clearFormAndState on reset threw:", e); }
      setAutoStatus("Saved — click Resume Scanning when ready for next card.");
      // CONSOLE-OFF v12 console.log("[scan] inventory:form:reset — scanner paused, state cleared");
    });

    $("startBtn")?.addEventListener("click", async () => {
      if (!window.Scanner) { status($("camStatus"), "Scanner not ready.", true); return; }
      try {
        status($("camStatus"), "Starting camera…");
        await window.Scanner.start();
        status($("camStatus"), "Camera ready. Hold a card steady; I'll auto-scan after ~2s.");
      } catch (e) {
        status($("camStatus"), "Could not start camera.", true); return;
      }
      setTogglePaused(false);
      setAutoStatus("Reading set code from bottom of card…");

      window.Scanner.startMonitor(
        async (result) => {
          try { await handleScanResult(result); }
          catch (e) { console.error("[scan] handleScanResult error:", e); status($("ocrStatus"), "Scan error; retrying…", true); }
        },
        (state, ms) => {
          const r = Math.max(0, Math.ceil((3000 - ms) / 1000));
          switch (state) {
            case "paused":   setAutoStatus("Scanning paused."); break;
            case "steady":   setAutoStatus(`Reading set code… (${r}s)`); break;
            case "moving":   setAutoStatus("Hold steady…"); break;
            case "lowlight": setAutoStatus("Low contrast — check lighting."); break;
            case "scanning": setAutoStatus("Reading set code + name…"); break;
            default:         setAutoStatus("Waiting for card…");
          }
        }
      );
    });

    $("scanToggleBtn")?.addEventListener("click", () => {
      if (!window.Scanner) return;
      if (isPaused) {
        clearFormAndState();
        try { window.Scanner.resume(); } catch (_) {}
        setTogglePaused(false);
        setAutoStatus("Reading set code from bottom of card…");
      } else {
        try { window.Scanner.pause(); } catch (_) {}
        setTogglePaused(true);
      }
    });

    // Accept & Confirm bar — v8.2 fix: do NOT force-enable confirmBtn.
    // enableQtyIfReady() already handles the enable condition (requires condition + qty).
    $("captureConfirmBtn")?.addEventListener("click", () => {
      hideCaptureConfirmBar();
      if (State.selectedSetName && State.selectedRarity) {
        // Code path: set/rarity already filled. Just prompt for condition + qty.
        enableQtyIfReady();
        status($("lookupStatus"), "Choose condition and enter quantity, then Post to Sheet.");
      } else {
        // Name path: trigger lookup
        const confText = $("ocrConf")?.textContent || "";
        const acc = parseInt(confText.replace(/[^0-9]/g, ""), 10) || 0;
        if (acc >= MIN_ACC || acc >= 65 || confText.includes("exact")) {
          $("lookupBtn")?.click();
        } else {
          status($("ocrStatus"), `Name accepted. Click "Find Printings" to continue.`);
        }
      }
    });

    $("captureRejectBtn")?.addEventListener("click", () => {
      hideCaptureConfirmBar();
      doRescan();
    });

    // Manual code input
    const manualCodeInput = $("manualCode");
    if (manualCodeInput) {
      manualCodeInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); doManualCodeLookup(manualCodeInput.value); }
      });
      $("codeLookupBtn")?.addEventListener("click", () => doManualCodeLookup(manualCodeInput.value));
      manualCodeInput.addEventListener("input", () => {
        try { window.Scanner.pause(); } catch (_) {}
        window.UI.showResume(true);
        setAutoStatus("Scanning paused (manual code entry)…");
      });
    }

    // Autocomplete on manual name
    (function() {
      const input = $("manualName");
      if (input && window.Autocomplete?.attach) {
        window.Autocomplete.attach(input, (name) => {
          try { window.Scanner.pause(); } catch (_) {}
          window.UI.showResume(true);
          setAutoStatus("Scanning paused (name selected)…");
          $("ocrName").value = name || "";
        });
      }
    })();

    // Pause when typing manual name
    (function() {
      const input = $("manualName"); if (!input) return;
      const pauseNow = () => {
        try { window.Scanner.pause(); } catch (_) {}
        window.UI.showResume(true);
        setAutoStatus("Scanning paused (manual typing)…");
      };
      input.addEventListener("input", pauseNow);
      input.addEventListener("keydown", pauseNow);
      input.addEventListener("focus", pauseNow);
    })();
  }

  window.UI.scan = window.UI.scan || {};
  window.UI.scan.bind = bind;
})();
