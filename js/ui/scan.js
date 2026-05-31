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

  // Restore a <select> to a single canonical "please select" placeholder.
  // Shared shape with confirm.js resetSelect + lookup.js makePlaceholder so the
  // Set/Rarity dropdowns never end up blank (#86 + UAT follow-up).
  function setPlaceholder(sel) {
    if (!sel) return;
    while (sel.firstChild) sel.removeChild(sel.firstChild);
    const ph = document.createElement("option");
    ph.value = "";
    ph.textContent = "please select";
    ph.disabled = true;
    ph.selected = true;
    sel.appendChild(ph);
    sel.value = "";
    if (sel.dataset) sel.dataset.populated = "0";
    sel.classList.remove("needs-input");
  }

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
    // v16 (#5): Condition must NEVER receive .needs-input — its default value is
    // acceptable on its own and does not require a manual pick. We force the
    // conditionSelect entry to `false` here so no caller (current or future)
    // can re-introduce the stray highlight, and we proactively strip any
    // pre-existing highlight on it as a belt-and-suspenders guard.
    // #85 (EPIC-87, AC-001): Set dropdown is now treated the same way —
    //   setSelect is forced to `false` so it can never receive the amber
    //   highlight from any caller.
    const ids = { setSelect: false, raritySelect: opts.rarity, conditionSelect: false, qty: opts.qty };
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

  // ── Capture confirm bar (v13.3: art-forward card, mirrors codeConfirmModal) ───
  // Reads from State.selectedPrinting / State.selectedCard as the single source of
  // truth (same as openCodeConfirmModal), then falls back to the passed candidate
  // object or string. This guarantees parity with the code-path review card.
  function showCaptureConfirmBar(candOrName, extra) {
    const bar = $("captureConfirmBar");
    if (!bar) return;

    const isObj = candOrName && typeof candOrName === "object";
    const cand  = isObj ? candOrName : {};
    const printing = (window.UI && window.UI.State && window.UI.State.selectedPrinting) || State?.selectedPrinting || {};
    const card     = (window.UI && window.UI.State && window.UI.State.selectedCard)     || State?.selectedCard     || {};

    // Name: candidate → printing → card → string arg → em-dash
    const name = (isObj ? cand.name : candOrName)
              || printing.name || card.name || "—";

    // Card ID for image URL: printing → card → candidate (try multiple key spellings)
    const id = printing.id || card.id
            || cand.id || cand.card_id || cand.passcode || null;

    // Meta fields
    const setCode = printing.set_code   || cand.set_code   || "";
    const rarity  = printing.set_rarity || cand.set_rarity || (window.UI?.State?.selectedRarity)  || "";
    const setName = printing.set_name   || cand.set_name   || (window.UI?.State?.selectedSetName) || "";

    // Image URL: explicit imageUrl on printing/cand → id-derived → none
    const imageUrl = printing.imageUrl || cand.imageUrl || cand.image_url_small || cand.image_url
                  || (id ? `https://images.ygoprodeck.com/images/cards_small/${id}.jpg` : null);

    const nameEl = $("captureConfirmName");
    const metaEl = $("captureConfirmMeta");
    const artEl  = $("captureConfirmArt");
    const label  = $("captureConfirmLabel");

    if (nameEl) nameEl.textContent = name;

    if (metaEl) {
      const parts = [];
      if (setCode) parts.push(setCode);
      if (rarity)  parts.push(rarity);
      if (setName) parts.push(setName);
      let metaText = parts.join(" · ");
      if (!metaText && extra) metaText = String(extra);
      metaEl.textContent = metaText;
    }

    if (artEl) {
      if (imageUrl) {
        artEl.onerror = function () {
          // If small variant fails and we have an id, try full-size; else hide
          if (id && !artEl.dataset.triedFull) {
            artEl.dataset.triedFull = "1";
            artEl.src = `https://images.ygoprodeck.com/images/cards/${id}.jpg`;
          } else {
            artEl.onerror = null;
            artEl.style.display = "none";
          }
        };
        delete artEl.dataset.triedFull;
        artEl.alt = name;
        artEl.src = imageUrl;
        artEl.style.display = "";
      } else {
        artEl.onerror = null;
        artEl.removeAttribute("src");
        artEl.style.display = "none";
      }
    }

    // Keep hidden legacy label populated for any code that still reads it
    if (label) {
      const extraStr = extra ? ` — ${extra}` : "";
      label.textContent = `Accept: "${name}"${extraStr}?`;
    }

    bar.style.display = "";
    hideCandidatesPicker();

    // v13.3: If we don't yet have an id, first try the synchronous in-memory cache
    // (instant on any previously-resolved card). If that hits, re-render immediately
    // without spinning up an async fetch.
    if (!id && name && name !== "—" && window.Lookup && typeof window.Lookup.getCachedByName === "function") {
      const cached = window.Lookup.getCachedByName(name);
      if (cached && cached.id) {
        // Promote into State so the modal and re-renders see it
        try {
          if (window.UI && window.UI.State) {
            window.UI.State.selectedCard = window.UI.State.selectedCard || {};
            if (!window.UI.State.selectedCard.id) {
              window.UI.State.selectedCard.id   = cached.id;
              window.UI.State.selectedCard.name = cached.name || name;
              window.UI.State.selectedCard.sets = cached.sets || [];
            }
          }
        } catch (_) {}
        // Re-render with the enriched data — returns synchronously, no spinner needed.
        return showCaptureConfirmBar({ id: cached.id, name: cached.name || name, sets: cached.sets || [] }, extra);
      }
    }

    // v13.2: If we still don't have an id (visual-only match, not in cache), fire a
    // name lookup to enrich the candidate. Show a placeholder shimmer in the art slot
    // so the bar doesn't look broken while the fetch is in flight.
    if (!id && name && name !== "—" && window.Lookup && typeof window.Lookup.fillSetsForCandidate === "function") {
      // v13.3: visible placeholder while fetching
      if (artEl && !imageUrl) {
        artEl.removeAttribute("src");
        artEl.style.display = "";
        artEl.classList.add("ccb-art-loading");
      }
      // Tag the bar with a fetch id so a stale fetch can't overwrite a newer scan.
      const fetchId = (bar.dataset.fetchId = String(Date.now()));
      const probe = { name };
      try {
        Promise.resolve(window.Lookup.fillSetsForCandidate(probe))
          .then(() => {
            if (artEl) artEl.classList.remove("ccb-art-loading");
            if (bar.dataset.fetchId !== fetchId) return; // superseded
            if (!probe.id && (!probe.sets || !probe.sets.length)) return;
            // Promote to selectedCard so the modal also sees the id
            try {
              if (window.UI && window.UI.State) {
                window.UI.State.selectedCard = window.UI.State.selectedCard || {};
                if (!window.UI.State.selectedCard.id && probe.id) {
                  window.UI.State.selectedCard.id   = probe.id;
                  window.UI.State.selectedCard.name = probe.name || name;
                  window.UI.State.selectedCard.sets = probe.sets || [];
                }
              }
            } catch (_) {}
            // Re-render the bar with the enriched data (re-entrant safe: id will
            // now be present so this fetch branch won't fire again).
            showCaptureConfirmBar(probe, extra);
          })
          .catch(function () {
            if (artEl) artEl.classList.remove("ccb-art-loading");
            /* silent — leave bar as-is */
          });
      } catch (_) { /* silent */ }
    }
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
    // Leroy F1/F2: tiles act as a single-choice toggle group; start unpressed.
    card.setAttribute("aria-pressed", "false");

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

    // #90 (EPIC-87, AC-010..013): selecting a tile no longer immediately
    //   commits. It marks the tile as selected; the single in-picker Confirm
    //   button (added in showCandidatesPicker) commits the selection. This
    //   restores the legacy multi-option picker with exactly one confirm step
    //   and no silent auto-pick.
    card.addEventListener("click", () => {
      if (typeof onPick === "function") onPick(c, card);
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

    // #90: track the currently-selected tile + candidate. Confirm is disabled
    //   until the user picks one (no silent auto-pick).
    // confirmBtn is declared below and only referenced from the click callback,
    // which fires long after this function returns (deferred use is safe).
    let confirmBtn  = null;
    let selectedCand = null;
    let selectedEl   = null;

    const list = document.createElement("div");
    list.className = "cand-list";
    candidates.forEach(c => list.appendChild(makeCandCard(c, scannedCode, (picked, cardEl) => {
      selectedCand = picked;
      // Leroy F2: clear ARIA + class on the previously-selected tile so screen
      //   readers don't report two "pressed" tiles after switching selection.
      if (selectedEl) {
        selectedEl.classList.remove("cand-card--selected");
        selectedEl.setAttribute("aria-pressed", "false");
      }
      selectedEl = cardEl;
      cardEl.classList.add("cand-card--selected");
      cardEl.setAttribute("aria-pressed", "true");
      if (confirmBtn) confirmBtn.disabled = false;
    })));
    picker.appendChild(list);

    const footer = document.createElement("div");
    footer.className = "cand-footer";

    // #90 (AC-011/AC-012): single in-picker Confirm button. Commits the chosen
    //   printing in one click — no separate codeConfirmModal afterward.
    confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = "primary cand-confirm";
    confirmBtn.textContent = "Confirm";
    confirmBtn.disabled = true;
    confirmBtn.addEventListener("click", () => {
      if (!selectedCand) return;
      hideCandidatesPicker(); hideCaptureConfirmBar();
      onPick && onPick(selectedCand);
    });
    footer.appendChild(confirmBtn);

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
    } else if (setSel) {
      // UAT fix: a name-fallback candidate carries no set_name, so don't leave
      //   the dropdown BLANK — restore the canonical "please select" placeholder.
      //   ("Find Printings" will then populate the real set options.)
      setPlaceholder(setSel);
    }

    const rarSel = $("raritySelect");
    if (rarSel && cand.set_rarity) {
      rarSel.innerHTML = "";
      const opt = document.createElement("option");
      opt.value = cand.set_rarity; opt.textContent = cand.set_rarity;
      rarSel.appendChild(opt);
      rarSel.value = cand.set_rarity;
      rarSel.classList.remove("needs-input");
    } else if (rarSel) {
      // UAT fix: same as Set — restore the placeholder instead of a blank box.
      setPlaceholder(rarSel);
    }

    status($("ocrStatus"), `Code match: ${cand.set_code || scannedCode} → ${name}`);
    $("ocrConf").textContent = `code: exact`;

    // v8.2: highlight fields still needing input (set/rarity already filled by code)
    // v16 (#5): Condition is intentionally NOT highlighted — its default is
    // acceptable and does not require a manual pick. applyNeedsInput() also
    // hard-forces condition:false, so this is belt-and-suspenders.
    const qtyVal     = parseInt($("qty")?.value || "0", 10);
    applyNeedsInput({
      set:       false,          // prefilled by code
      rarity:    false,          // prefilled by code
      condition: false,          // #5: never highlight Condition
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

    // Rebuild the canonical "please select" placeholder instead of wiping the
    // <select> to a blank box. Clearing innerHTML left Set/Rarity empty between
    // scans (UAT round 4) while Condition kept its placeholder option.
    setPlaceholder($("setSelect"));
    setPlaceholder($("raritySelect"));
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
            // willReadFrequently:true — this canvas is read back via getImageData
            // downstream (image assist / band detect), avoids the Canvas2D warning (#68).
            wc.getContext("2d", { willReadFrequently: true }).drawImage(v, 0, 0);
            candidates = await ia.scoreVisually(candidates, wc);
          }
        } catch (_) {}
      }

      if (candidates.length === 1) {
        applyCodeCandidate(candidates[0], code);
        setMatchSource("manual-code", code);
        showCaptureConfirmBar(candidates[0], candidates[0].set_code || code);
      } else {
        status($("lookupStatus"), `${candidates.length} printings found for ${code}.`);
        setAutoStatus("Multiple printings — choose one below.");
        showCandidatesPicker(candidates, code, (picked) => {
          applyCodeCandidate(picked, code);
          setMatchSource("manual-code", picked.set_code || code);
          showCaptureConfirmBar(picked, picked.set_code || code);
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

    // UAT fix (issue: "confirm the card twice"): the multi-option picker is
    //   ONLY for disambiguating multiple printings. With a single candidate we
    //   must route straight to the capture-confirm bar regardless of OCR
    //   confidence — otherwise a low-confidence single match (e.g. an 84% name
    //   fallback) showed the picker (pick tile + Confirm) AND THEN the
    //   capture-confirm bar, forcing the user to confirm the same card twice.
    //   Confidence only affects the status copy now, not the branch.
    if (candidates.length === 1) {
      applyCodeCandidate(best, primaryCode);
      const label = best.set_code ? `${best.set_code} · ${best.set_rarity || "?"}` : (best.set_rarity || "");
      const confident = best.exactMatch || (best.score || 0) >= 0.90;
      setAutoStatus(confident
        ? `Found: ${best.name}. Choose condition + qty, then confirm.`
        : `Best match: ${best.name}. Choose condition + qty and confirm, or Rescan if wrong.`);
      showCaptureConfirmBar(best, label || null);
      return;
    }

    // #90 (EPIC-87, AC-010..013): revert #55's silent auto-pick. When a lookup
    //   returns multiple printings, show the multi-option picker so the user
    //   selects the correct Set/Rarity printing. Selecting a tile + the single
    //   in-picker Confirm commits the choice (no codeConfirmModal double-step),
    //   then routes into the existing capture-confirm bar where Condition + Qty
    //   stay (unchanged). Single-match branch above is untouched.
    setAutoStatus(`Multiple printings for ${best.name} — choose one below.`);
    showCandidatesPicker(
      candidates,
      primaryCode || "",
      (picked) => {
        applyCodeCandidate(picked, primaryCode || picked.set_code || "");
        if (scanMode === "code") setMatchSource("exact-code", picked.set_code || primaryCode);
        else setMatchSource("name-fallback", scannedText || "");
        const lbl = picked.set_code
          ? `${picked.set_code} · ${picked.set_rarity || ""}`.trim()
          : (picked.set_rarity || "");
        setAutoStatus(`Selected: ${picked.name}. Choose condition + qty, then confirm.`);
        showCaptureConfirmBar(picked, lbl || null);
      },
      doRescan
    );
  }

  // ── Bind UI actions ────────────────────────────────────────────────────────────
  function bind() {
    // v10.1: post-success reset. Pause the scanner + clear everything so the
    //        camera doesn't immediately re-fire on the same card.
    document.addEventListener("inventory:form:reset", () => {
      try { window.Scanner?.pause?.(); } catch (_) {}
      setTogglePaused(true);
      // #45: defensively clear the scan-owned field + state on reset so the
      // read-only Scanned Name never lingers on a stale value (it must always
      // reflect the current scan, or fall back to its empty placeholder).
      // confirm.js already blanks #ocrName before dispatching, but we no longer
      // depend on that ordering. Console output stays silent (no warn/log) to
      // preserve the clean-console standard from #48.
      try { clearFormAndState(); } catch (_) {}
      setAutoStatus("Saved — click Resume Scanning when ready for next card.");
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

    // Accept & Confirm bar — v13.1: behave the same as the code-path confirm flow.
    // If we already have a resolved printing (set + rarity present), open the
    // codeConfirmModal review card (identical UX to the code path). Otherwise,
    // fall back to the legacy name-path lookup trigger.
    $("captureConfirmBtn")?.addEventListener("click", () => {
      hideCaptureConfirmBar();
      if (State.selectedSetName && State.selectedRarity) {
        // Resolved card → enable Post button readiness, then open the review modal.
        enableQtyIfReady();
        const previewCode = State?.selectedPrinting?.set_code || "";
        // Prefer the canonical opener exposed by confirm.js; fall back to clicking
        // the existing confirmBtn (which triggers the same modal flow).
        if (window.UI && typeof window.UI.openCodeConfirmModal === "function") {
          window.UI.openCodeConfirmModal(previewCode);
        } else {
          $("confirmBtn")?.click();
        }
      } else {
        // Name path: no printing resolved yet — trigger printings lookup.
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
  // #90 (EPIC-87): expose the multi-option picker for direct use/testing.
  window.UI.scan.showCandidatesPicker = showCandidatesPicker;
  // UAT: expose the scan-result router for direct use/testing.
  window.UI.scan.handleScanResult = handleScanResult;
})();
