// js/ui/scan.js  — v14.4 (EPIC-93: cross-tick accumulator + popup-first name path)
// v14.4:
//   • Cross-tick candidate accumulator: across ACCUM_WINDOW_TICKS (3) scan ticks,
//     if 2+ distinct card IDs appear at score ≥ MULTI_PICK_SCORE, show the
//     card-select modal. Fixes the UAT issue where a card like "Kewl Tune Rotary"
//     scanned for 40+ seconds without triggering the picker because each tick
//     returned a different single candidate at low confidence.
//   • captureConfirmBtn name-path: lookupBtn.click() now routes to
//     openCodeConfirmModalWithPicker via lookup.js v14.4 — never inline form.
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

  // v14.3: Minimum score for a candidate to count toward the ambiguity check.
  // When 2+ candidates each reach this threshold, we show the picker instead of
  // auto-applying the top hit, even if only one candidate exists in the result
  // array. Matches the new core.js ACCEPTABLE_SCORE floor.
  const MULTI_PICK_SCORE = 0.40;

  // v14.4: Cross-tick candidate accumulator.
  // Each scan tick gives us 1 best-match candidate from a slightly different OCR
  // read of the same card name. By itself a single tick only produces 1 candidate,
  // so the ambiguity check (aboveThreshold.length >= 2) never fires — even though
  // the scanner is clearly seeing multiple plausible cards across successive reads.
  //
  // Strategy: keep a rolling window of the last ACCUM_WINDOW_TICKS top candidates.
  // If 2+ *distinct card IDs* appear at score >= MULTI_PICK_SCORE within that
  // window, merge them into a deduped picker list and show the modal.
  //
  // We reset the accumulator whenever:
  //   (a) an exactMatch is found (code match → auto-apply immediately), or
  //   (b) a single card has won every tick in the window (unambiguous winner), or
  //   (c) the scanner is resumed / form is reset (clearFormAndState called).
  const ACCUM_WINDOW_TICKS = 3; // trigger after 3 ticks if still ambiguous
  let _accumCandidates = []; // [{id, name, score, imageUrl, ...}, ...] across ticks
  let _accumText       = ""; // OCR text of first tick in current window

  function _resetAccumulator() {
    _accumCandidates = [];
    _accumText       = "";
  }

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

  // ── Match-source status bar ─────────────────────────────────────────────────
  // mode: "exact-code" | "code-unresolved" | "name-fallback" | "manual-code" | ""
  //
  // UAT round 5: the bar previously surfaced on every match — including the
  // normal success/name-fallback cases — which was noisy and used outdated
  // wording. It now ONLY renders for genuine errors (a scanned code that could
  // not be resolved). All other modes are tracked silently so downstream state
  // is unaffected, but no banner is shown.
  const ERROR_MODES = { "code-unresolved": true };
  function setMatchSource(mode, detail) {
    const bar   = $("matchSourceBar");
    const label = $("matchSourceLabel");
    const icon  = $("matchSourceIcon");
    if (!bar || !label) return;

    const labels = {
      "code-unresolved": "⚠ Couldn’t read a set code — double-check Set & Rarity",
    };

    const show = !!ERROR_MODES[mode];
    bar.style.display = show ? "" : "none";
    bar.setAttribute("data-mode", show ? mode : "");
    if (!show) { label.textContent = ""; return; }
    label.textContent = (labels[mode] || mode) + (detail ? ` — ${detail}` : "");
    if (icon) icon.textContent = "●";
  }
  window.UI.setMatchSource = setMatchSource;

  // ── .needs-input highlight helpers (v8.2) ────────────────────────────────────
  // v14.2: applyNeedsInput now passes opts through without forcing any field
  // to false. The old hardcoded suppression of set/condition was left over from
  // a time when those fields were always pre-filled by the code-match path.
  // The canonical highlight path is now confirm.js highlightMissingFields()
  // (cue-needs-input amber ring). applyNeedsInput is kept for backward compat
  // with the legacy .needs-input CSS class but no longer overrides caller intent.
  function applyNeedsInput(opts) {
    // opts: { set: bool, rarity: bool, condition: bool, qty: bool }
    const ids = {
      setSelect:       !!opts.set,
      raritySelect:    !!opts.rarity,
      conditionSelect: !!opts.condition,
      qty:             !!opts.qty,
    };
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

  // ── EPIC-93 Story #96: Card Select Modal (AC-002 / AC-003) ───────────────────
  // Routes multi-candidate selection through #cardSelectModal (a centered popup)
  // instead of the inline #candidatesPicker in the form. Candidate tiles and the
  // single Confirm button are rendered inside the modal body; Rescan cancels.
  function openCardSelectModal(candidates, scannedCode, onPick, onRescan) {
    const modal = $("cardSelectModal");
    const body  = $("cardSelectModalBody");
    if (!modal || !body) {
      // Fallback: legacy inline picker if modal element not present
      showCandidatesPicker(candidates, scannedCode, onPick, onRescan);
      return;
    }

    // Update title to include code if available
    const titleEl = $("cardSelectModalTitle");
    if (titleEl) titleEl.textContent = scannedCode ? `Code "${scannedCode}" — choose printing` : "Choose matching card";

    body.innerHTML = "";

    // Re-use the existing makeCandCard builder for visual parity
    let confirmBtn  = null;
    let selectedCand = null;
    let selectedEl   = null;

    const hasVis = candidates.some(c => typeof c.imgScore === "number");
    if (hasVis) {
      const visNote = document.createElement("div");
      visNote.className = "cand-vis-note";
      visNote.textContent = "Visual similarity scored against card art (browser-only, 32×32 crop).";
      body.appendChild(visNote);
    }

    const list = document.createElement("div");
    list.className = "cand-list";
    candidates.forEach(c => list.appendChild(makeCandCard(c, scannedCode, (picked, cardEl) => {
      selectedCand = picked;
      if (selectedEl) {
        selectedEl.classList.remove("cand-card--selected");
        selectedEl.setAttribute("aria-pressed", "false");
      }
      selectedEl = cardEl;
      cardEl.classList.add("cand-card--selected");
      cardEl.setAttribute("aria-pressed", "true");
      if (confirmBtn) confirmBtn.disabled = false;
    })));
    body.appendChild(list);

    const footer = document.createElement("div");
    footer.className = "cand-footer";

    confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = "primary cand-confirm";
    confirmBtn.textContent = "Confirm";
    confirmBtn.disabled = true;
    confirmBtn.addEventListener("click", () => {
      if (!selectedCand) return;
      _closeCardSelectModal();
      onPick && onPick(selectedCand);
    });
    footer.appendChild(confirmBtn);

    const rescanBtn = document.createElement("button");
    rescanBtn.type = "button";
    rescanBtn.className = "secondary cand-rescan";
    rescanBtn.textContent = "Rescan";
    rescanBtn.addEventListener("click", () => {
      _closeCardSelectModal();
      hideCaptureConfirmBar();
      onRescan && onRescan();
    });
    footer.appendChild(rescanBtn);
    body.appendChild(footer);

    // Wire close-X button (AC-007)
    const closeX = $("cardSelectCloseX");
    if (closeX) {
      closeX.onclick = () => { _closeCardSelectModal(); onRescan && onRescan(); };
    }

    // Backdrop click closes (AC-007)
    modal.querySelector(".modal__backdrop")?.addEventListener("click", (e) => {
      if (e.target === e.currentTarget) { _closeCardSelectModal(); onRescan && onRescan(); }
    }, { once: true });

    // Esc to close (AC-007)
    const escHandler = (e) => {
      if (e.key === "Escape" && modal.classList.contains("is-open")) {
        _closeCardSelectModal();
        onRescan && onRescan();
        document.removeEventListener("keydown", escHandler);
      }
    };
    document.addEventListener("keydown", escHandler);

    // Open the modal
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    const dialog = modal.querySelector(".modal__dialog");
    if (dialog) { dialog.setAttribute("tabindex", "-1"); dialog.focus(); }
    document.documentElement.style.overflow = "hidden";
  }

  function _closeCardSelectModal() {
    const modal = $("cardSelectModal");
    if (!modal) return;
    if (window.UI?.moveFocusOutOf) window.UI.moveFocusOutOf(modal);
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    document.documentElement.style.overflow = "";
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

    enableQtyIfReady();

    // v14.3: After applying a code candidate, check which required fields are
    // actually missing in the live DOM and highlight ALL of them, not just
    // Condition. Previously this block hard-coded only conditionSelect, which
    // meant Set/Rarity went unhighlighted when the candidate had no set_name
    // or set_rarity (name-only OCR path with a code prefix that resolved to
    // a card but no printing data). Now we collect every missing field and
    // delegate to window.UI.highlightMissingFields (confirm.js shared helper)
    // so the visual behaviour is identical everywhere.
    try {
      const setVal    = $("setSelect")?.value    || "";
      const rarVal    = $("raritySelect")?.value || "";
      const condVal   = $("conditionSelect")?.value || "";
      const qtyFinal  = parseInt($("qty")?.value || "0", 10);

      if (setVal && rarVal && condVal && qtyFinal >= 1) {
        // All fields populated — fire the green ready cue
        window.UI?.cue?.fireReady?.();
      } else {
        // Build missing list and highlight every unfilled field with amber ring
        const missing = [];
        if (!setVal)       missing.push("set");
        if (!rarVal)       missing.push("rarity");
        if (!condVal)      missing.push("condition");
        if (qtyFinal < 1)  missing.push("qty");
        if (window.UI && typeof window.UI.highlightMissingFields === "function") {
          window.UI.highlightMissingFields(missing);
        } else {
          // Fallback: at minimum fire the tone on conditionSelect (legacy behaviour)
          if (!condVal) window.UI?.cue?.fireNeedsInput?.($("conditionSelect"));
        }
      }
    } catch (_) {}
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
    _resetAccumulator();
    const ocr = $("ocrName");    if (ocr) ocr.value = "";
    const man = $("manualName"); if (man) man.value = "";
    const mc  = $("manualCode"); if (mc)  mc.value  = "";

    // EPIC-93: clear any active cue highlights on form reset
    try { window.UI?.cue?.clearCues?.(); } catch (_) {}
    hideCaptureConfirmBar();
    hideCandidatesPicker();
    _closeCardSelectModal();
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
    _resetAccumulator();
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
        // EPIC-93 Story #96 (AC-002/AC-003): use centered card-select modal popup
        openCardSelectModal(candidates, code, (picked) => {
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

    // v14.3/v14.4: Ambiguity check — two-layer strategy:
    //
    // Layer 1 (single tick): if this tick's result already contains 2+ candidates
    //   each ≥ MULTI_PICK_SCORE AND the top hit is not an exact code match, we can
    //   show the picker immediately (happens when OCR is clear + DB returns close
    //   matches with similar scores).
    //
    // Layer 2 (cross-tick accumulator): each name-mode scan tick often yields only
    //   1 candidate above threshold from a slightly-mangled OCR read. We accumulate
    //   top candidates across ACCUM_WINDOW_TICKS ticks; if 2+ *distinct card IDs*
    //   appear, the scanner is genuinely ambiguous and we show the picker.
    //
    // Reset accumulator on exact-code match (no ambiguity possible) or when the
    //   form is reset (clearFormAndState already calls _resetAccumulator via the
    //   inventory:form:reset listener below).

    const aboveThreshold = candidates.filter(c => (c.blendedScore || c.score || 0) >= MULTI_PICK_SCORE);

    // Exact match — always auto-apply, no accumulation needed
    if (best.exactMatch) {
      _resetAccumulator();
      applyCodeCandidate(best, primaryCode);
      const label = best.set_code ? `${best.set_code} · ${best.set_rarity || "?"}` : (best.set_rarity || "");
      setAutoStatus(`Found: ${best.name}. Choose condition + qty, then confirm.`);
      showCaptureConfirmBar(best, label || null);
      return;
    }

    // Layer 1: immediate multi-candidate check (this tick alone)
    const isAmbiguousNow = aboveThreshold.length >= 2;

    if (isAmbiguousNow) {
      _resetAccumulator();
      const pickerMsg = `${aboveThreshold.length} possible matches — which card is this?`;
      setAutoStatus(pickerMsg);
      openCardSelectModal(
        candidates,
        primaryCode || "",
        (picked) => {
          _resetAccumulator();
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
      return;
    }

    // Layer 2: cross-tick accumulation for name-mode ambiguity
    // Only accumulate when scanMode is "name" (code mode with 1 candidate is fine to auto-apply)
    if (scanMode === "name") {
      // Seed the window text on first tick
      if (!_accumText) _accumText = scannedText || "";

      // Merge top candidate(s) from this tick into the accumulator
      aboveThreshold.forEach(c => {
        if (!_accumCandidates.some(a => a.id === c.id)) {
          _accumCandidates.push(c);
        } else {
          // Update score to highest seen so far
          const existing = _accumCandidates.find(a => a.id === c.id);
          if (existing && (c.blendedScore || c.score || 0) > (existing.blendedScore || existing.score || 0)) {
            Object.assign(existing, c);
          }
        }
      });

      // Check if we've accumulated enough ticks (guard: _accumCandidates grows only when IDs differ)
      const distinctIds = new Set(_accumCandidates.map(c => c.id)).size;
      const tickCount   = _accumCandidates.length;

      if (distinctIds >= 2 && tickCount >= ACCUM_WINDOW_TICKS) {
        // Ambiguity confirmed across multiple ticks — show the picker
        const accumulated = [..._accumCandidates].sort((a, b) =>
          (b.blendedScore || b.score || 0) - (a.blendedScore || a.score || 0)
        );
        _resetAccumulator();
        setAutoStatus(`${accumulated.length} possible matches — which card is this?`);
        openCardSelectModal(
          accumulated,
          primaryCode || "",
          (picked) => {
            _resetAccumulator();
            applyCodeCandidate(picked, primaryCode || picked.set_code || "");
            setMatchSource("name-fallback", _accumText || scannedText || "");
            const lbl = picked.set_code
              ? `${picked.set_code} · ${picked.set_rarity || ""}`.trim()
              : (picked.set_rarity || "");
            setAutoStatus(`Selected: ${picked.name}. Choose condition + qty, then confirm.`);
            showCaptureConfirmBar(picked, lbl || null);
          },
          doRescan
        );
        return;
      }
    }

    // Single clear winner (or accumulation not yet triggered) — auto-apply.
    // If distinctIds === 1 across multiple ticks, the scanner is confident in this card.
    _resetAccumulator();
    applyCodeCandidate(best, primaryCode);
    const label = best.set_code ? `${best.set_code} · ${best.set_rarity || "?"}` : (best.set_rarity || "");
    const confident = (best.score || 0) >= 0.90;
    setAutoStatus(confident
      ? `Found: ${best.name}. Choose condition + qty, then confirm.`
      : `Best match: ${best.name}. Choose condition + qty and confirm, or Rescan if wrong.`);
    showCaptureConfirmBar(best, label || null);
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

    // Accept & Confirm bar (v14.2: no double-confirm, no codeConfirmModal bypass)
    //
    // Flow:
    //   1. If printing is resolved (set+rarity in State from code/picker): read live
    //      DOM values, check all required fields. If all filled → post directly.
    //      If any field is missing → fire amber highlights on ALL missing fields
    //      and show inline error. codeConfirmModal is NEVER opened from this path.
    //   2. If printing not resolved yet (name-only path): trigger printings lookup.
    //
    // Why codeConfirmModal was removed from the incomplete-form path:
    //   The modal's Confirm button called postCurrentSelection() which called
    //   buildRowFromUI() which used State.selectedSetName/Rarity (stale) instead
    //   of the live DOM value, so it posted even when the dropdown showed
    //   "please select". Removing the modal eliminates that bypass entirely.
    $("captureConfirmBtn")?.addEventListener("click", () => {
      hideCaptureConfirmBar();
      if (State.selectedSetName && State.selectedRarity) {
        enableQtyIfReady();
        // Read required fields from the live DOM — never from State (State is stale).
        const condVal   = $("conditionSelect")?.value || "";
        const qtyVal    = parseInt($("qty")?.value || "0", 10);
        const setVal    = $("setSelect")?.value    || "";
        const rarityVal = $("raritySelect")?.value || "";
        const allFilled = !!(condVal && qtyVal >= 1 && setVal && rarityVal);

        if (allFilled) {
          // All fields complete — post directly, no modal (Fix 2)
          if (window.UI && typeof window.UI.postCurrentSelection === "function") {
            window.UI.postCurrentSelection();
          } else {
            $("confirmBtn")?.click();
          }
        } else {
          // One or more fields missing — fire amber highlights on ALL of them
          // and surface a status error. Do NOT open codeConfirmModal (it bypassed
          // the gate by reading stale State instead of the live DOM).
          const missing = [];
          if (!setVal)      missing.push("set");
          if (!rarityVal)   missing.push("rarity");
          if (!condVal)     missing.push("condition");
          if (qtyVal < 1)   missing.push("qty");
          // Delegate highlighting to confirm.js shared helper (one system, Fix 3)
          if (window.UI && typeof window.UI.highlightMissingFields === "function") {
            window.UI.highlightMissingFields(missing);
          }
          // Surface first missing field as an error in the status bar
          const firstLabel = { set: "Set", rarity: "Rarity", condition: "Condition", qty: "Qty" };
          const firstMissing = missing[0];
          const errMsg = firstMissing
            ? `Please select a ${firstLabel[firstMissing] || firstMissing} before posting.`
            : "Please fill out all required fields.";
          const confirmStatus = $("confirmPickStatus") || $("confirmStatus");
          if (confirmStatus) {
            confirmStatus.textContent = errMsg;
            confirmStatus.className = "status error";
          }
        }
      } else {
        // Name path: no printing resolved yet — fetch printings and open the
        // picker popup directly. NEVER call lookupBtn.click() here because that
        // populates the inline form dropdowns and leaves the user without a popup.
        // v14.4: all set/rarity/condition selection goes through the popup.
        const confText = $("ocrConf")?.textContent || "";
        const acc = parseInt(confText.replace(/[^0-9]/g, ""), 10) || 0;
        if (acc >= MIN_ACC || acc >= 65 || confText.includes("exact")) {
          // Trigger the lookup flow, which will call openCodeConfirmModalWithPicker
          // at the end via lookup.js's _openPickerForCard() helper.
          // We route through the existing lookupBtn machinery so all the state
          // setup (State.selectedCard, populateSetDropdown, safety-net) runs
          // exactly once. lookup.js v14.4 will open the popup when ready.
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
  // Legacy inline picker (kept for backward compat; use openCardSelectModal for new flows)
  window.UI.scan.showCandidatesPicker = showCandidatesPicker;
  // EPIC-93 Story #96: centered modal picker
  window.UI.scan.openCardSelectModal = openCardSelectModal;
  // UAT: expose the scan-result router for direct use/testing.
  window.UI.scan.handleScanResult = handleScanResult;
})();
