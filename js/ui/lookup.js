// js/ui/lookup.js  — v14.4 (EPIC-93: popup-first name path)
// v14.4:
//   • After printings load (both normal and safety-net paths), calls
//     window.UI.openCodeConfirmModalWithPicker() so Set/Rarity/Condition are
//     chosen inside the popup — never in the inline form dropdowns.
//   • Fallback: if confirm.js not yet loaded or printings fail, inline status
//     message guides user to pick condition and post.
// v13.4 changes (Sprint 2 — closes #5, #6):
//   • Issue #6: Set / Rarity dropdown placeholders restored. All three
//     repopulate paths (populateSetDropdown, initial rarity wipe after
//     name pick, rarity rebuild on set-change) now emit
//     `<option value='' disabled selected>Set|Rarity</option>` instead of
//     the previous "please select" label. Placeholder is disabled so users
//     cannot re-select it after picking a real option.
//   • Issue #5: Stop nuking persisted Condition on every name-lookup run.
//     Previously the click handler unconditionally did
//       $("conditionSelect").value = "";
//       State.selectedCondition = null;
//     which wiped the localStorage-restored condition AND left
//     conditionSelect briefly empty (causing the stray .needs-input that
//     scan.js' code-match path could re-apply). We now preserve any
//     existing condition value (typical workflow: user scans many cards
//     of the same condition) and defensively strip .needs-input from
//     conditionSelect on every repopulate path.
//
// v10.4: status message updated to reflect the cardset-scan fallback may take
//        several seconds when the primary cardinfo.php paths are down.
// v9.2: Safety-net for empty Set/Rarity dropdowns. When the picked candidate has
//       no sets (the v9.1 synthetic-only path), call Lookup.fillSetsForCandidate()
//       to fetch them from YGOPRODeck and repopulate the dropdowns. Also factored
//       the dropdown populate logic into populateSetDropdown() so both the normal
//       path and the safety-net path go through the same code.
// v8.2: clear .needs-input from set/rarity selects when name-path populates them.
// Extended from v7.1:
//   • Preserve existing "Find Printings" name-based flow unchanged.
//   • The "Find Printings" button also checks if a manual code is entered
//     and routes to the code search path first.
//   • Set/rarity selects are still populated from fetched printing data
//     (unchanged API shape from v7.1).
(function(){
  'use strict';

  window.UI = window.UI || {};
  const $ = window.UI.$;
  const State = window.UI.State;
  const status = window.UI.status;
  const enableQtyIfReady = window.UI.enableQtyIfReady;
  const resetFlowForNewPick = window.UI.resetFlowForNewPick;

  function currentName(){
    const m = $("manualName")?.value.trim();
    if (m) return { text: m, source: "manual" };
    const o = $("ocrName")?.value.trim();
    if (o) return { text: o, source: "scanned" };
    return { text: "", source: "none" };
  }

  // v13.4 (Sprint 2, #6): shared placeholder factory so every repopulate path
  // emits the same `<option value='' disabled selected>Label</option>` shape.
  function makePlaceholder(label) {
    const ph = document.createElement("option");
    ph.value = "";
    ph.textContent = label;
    ph.disabled = true;
    ph.selected = true;
    return ph;
  }

  // v9.2: shared populate helper so safety-net path reuses identical logic
  // v13.4 (Sprint 2, #6): placeholder label is now "Set" (not "please select").
  // v13.4 (#23): no trailing setSel.value="" — the disabled-selected placeholder
  //   is already the chosen option; setting value="" was a no-op that could
  //   visually blank the closed dropdown in some browsers.
  function populateSetDropdown() {
    const setSel = $("setSelect");
    if (!setSel) return;
    const sets = [...new Set((State.selectedCard?.sets || []).map(p => p.set_name).filter(Boolean))];
    setSel.innerHTML = "";
    // v24 (#25): unified placeholder "please select" — was "Set" when populateSetDropdown()
    // ran after candidate confirm, causing the placeholder to regress mid-flow.
    setSel.appendChild(makePlaceholder("please select"));
    sets.forEach(n => {
      const o = document.createElement("option");
      o.value = n; o.textContent = n;
      setSel.appendChild(o);
    });
    // #85 (EPIC-87, AC-001): the Set dropdown must NEVER show the amber
    //   .needs-input highlight. Mirrors the Condition exclusion from #5.
    //   Previously: `if (sets.length > 0) setSel.classList.add("needs-input")`
    //   added a misleading "invalid" highlight even on a valid populated list.
    setSel.classList.remove("needs-input");
  }

  function bind(){
    $("lookupBtn")?.addEventListener("click", async () => {
      // v8: if manual code field is populated, prefer code search path
      const manualCode = ($("manualCode")?.value || "").trim().toUpperCase();
      if (manualCode && manualCode.includes("-")) {
        // Delegate to scan.js manual code lookup (it handles all UX)
        if (window.UI.scan && typeof window.UI.scan.doManualCodeLookup === "function") {
          window.UI.scan.doManualCodeLookup(manualCode);
        } else {
          // Inline fallback if scan.js isn't wired yet
          const cs = window.Lookup?.codeSearch || window.LookupParts?.codeSearch;
          if (cs) {
            status($("lookupStatus"), `Looking up code ${manualCode}…`);
            try {
              const res = await cs.resolveCode(manualCode);
              if (!res || !res.candidates?.length) {
                status($("lookupStatus"), `No match for "${manualCode}".`, true);
                return;
              }
              // Fall through to name-path with first candidate's name
              const best = res.candidates[0];
              $("ocrName").value = best.name;
              $("manualCode").value = best.set_code || manualCode;
            } catch (e) {
              status($("lookupStatus"), "Code lookup failed.", true); return;
            }
          }
        }
        return; // code path handled its own UX
      }

      // === Name-based lookup (unchanged from v7.1) ===
      const chosen = currentName();
      if (!chosen.text) { status($("lookupStatus"), "Enter or scan a card first.", true); return; }

      resetFlowForNewPick();
      try { window.Scanner.pause(); window.UI.showResume(true); $("autoStatus").textContent = "Scanning paused (lookup)…"; } catch (_) {}
      status($("lookupStatus"), `Searching YGOPRODeck…`);
      $("setSelect").innerHTML = ""; $("raritySelect").innerHTML = "";
      // v13.4 (Sprint 2, #5): DO NOT wipe Condition on every name lookup.
      // The previous wipe (`conditionSelect.value = ""` + `selectedCondition = null`)
      // erased the persisted/restored condition every time the user picked
      // a new name candidate, which both broke the same-condition scan flow
      // and caused a stray .needs-input flash on Condition. Preserve any
      // existing value and proactively strip its needs-input highlight.
      const _cond = $("conditionSelect");
      if (_cond?.value) {
        State.selectedCondition = _cond.value;
        _cond.classList.remove("needs-input");
      }
      State.selectedCard = State.selectedPrinting = State.selectedSetName = State.selectedRarity = null;

      try {
        if (chosen.source === "manual" && typeof window.Lookup?.resolveNameFromScanNgrams === "function") {
          const canonical = await window.Lookup.resolveNameFromScanNgrams(chosen.text);
          if (!canonical) {
            status($("lookupStatus"), "Couldn't confidently match that name (≥65%). Refine or pick from suggestions.", true);
            return;
          }
          $("manualName").value = canonical;
          chosen.text = canonical;
          $("autoStatus").textContent = "Scanning paused (name locked)…";
        }

        const candidates = await window.Lookup.fetchCandidates(chosen.text);
        if (!candidates.length) { status($("lookupStatus"), "No matches found.", true); return; }

        const lower = chosen.text.toLowerCase();
        let pick = candidates.find(c => (c?.name || "").toLowerCase() === lower);
        if (!pick && typeof window.Lookup?.bestNameMatch === "function") {
          const idx = window.Lookup.bestNameMatch(chosen.text, candidates);
          pick = (idx >= 0) ? candidates[idx] : null;
        }
        if (!pick) { status($("lookupStatus"), "No confident match.", true); return; }

        State.selectedCard = pick;

        // v9.2: Refactored — single place to populate the Set dropdown from
        // the current selectedCard, so the safety-net path can reuse it.
        populateSetDropdown();

        // v24 (#24): unified placeholder "please select" across all dropdowns.
        // v13.4 (#23): no trailing rarSel.value="" — placeholder is already selected.
        const rarSel = $("raritySelect"); rarSel.innerHTML = "";
        rarSel.appendChild(makePlaceholder("please select"));

        status($("lookupStatus"), `Found ${candidates.length} match(es).`);
        enableQtyIfReady();

        // Helper: open the picker popup with the card's current sets.
        // v14.4: all set/rarity/condition selection happens inside the popup;
        //        the inline dropdowns are still populated for fallback but the
        //        user is never directed to interact with them directly.
        function _openPickerForCard() {
          const cardSets = State.selectedCard?.sets || [];
          const condVal  = $("conditionSelect")?.value || State.selectedCondition || "";
          if (typeof window.UI?.openCodeConfirmModalWithPicker === "function") {
            window.UI.openCodeConfirmModalWithPicker(cardSets, condVal);
          } else {
            // Fallback: if confirm.js hasn't loaded yet, prompt inline
            status($("confirmPickStatus"), "Select set → rarity → condition, then enter quantity.");
          }
        }

        // v9.2: SAFETY NET — if the picked candidate landed with empty sets
        // (the synthetic local-only path from api.js, or some other gap),
        // fetch them now and repopulate the dropdown. This guarantees the
        // user gets a real set/rarity choice whenever YGOPRODeck is healthy.
        const currentSets = Array.isArray(State.selectedCard.sets) ? State.selectedCard.sets : [];
        const needsFill = currentSets.length === 0 || pick.__synthetic === true;
        if (needsFill && typeof window.Lookup?.fillSetsForCandidate === "function") {
          status($("lookupStatus"), `Found ${candidates.length} match(es). Fetching printings…`);
          try {
            const ok = await window.Lookup.fillSetsForCandidate(State.selectedCard);
            if (ok && Array.isArray(State.selectedCard.sets) && State.selectedCard.sets.length) {
              populateSetDropdown();
              status($("lookupStatus"), `Found ${candidates.length} match(es). ✓ ${State.selectedCard.sets.length} printing(s) loaded.`);
              _openPickerForCard();
            } else {
              // v10.2: name is sufficient — don't demand a set code.
              status($("lookupStatus"), `Found ${candidates.length} match(es). ⚠ Couldn't load printings — pick a Condition and Post to Sheet.`, true);
              status($("confirmPickStatus"), "Pick a condition, then enter quantity.");
              enableQtyIfReady();
            }
          } catch (e) {
            // CONSOLE-OFF v12 console.warn('[lookup] sets safety-net threw:', e);
            status($("lookupStatus"), `Found ${candidates.length} match(es). ⚠ Couldn't load printings — pick a Condition and Post to Sheet.`, true);
            status($("confirmPickStatus"), "Pick a condition, then enter quantity.");
            enableQtyIfReady();
          }
        } else {
          // Sets already present — open the picker immediately
          _openPickerForCard();
        }
      } catch (e) {
        console.error(e);
        status($("lookupStatus"), "Lookup failed.", true);
      }
    });

    $("setSelect")?.addEventListener("change", () => {
      State.selectedSetName = $("setSelect").value || null;
      const rarities = [...new Set((State.selectedCard?.sets||[]).filter(p=>p.set_name===State.selectedSetName).map(p=>p.set_rarity).filter(Boolean))];
      const rarSel = $("raritySelect"); rarSel.innerHTML = "";
      // v13.4 (Sprint 2, #6): rarity placeholder → "Rarity"
      // v13.4 (#23): no trailing rarSel.value="" — placeholder is already selected.
      rarSel.appendChild(makePlaceholder("please select"));
      rarities.forEach(r => { const o = document.createElement("option"); o.value = r; o.textContent = r; rarSel.appendChild(o); });
      State.selectedRarity = State.selectedPrinting = null;
      // v13.4 (Sprint 2, #5): preserve Condition across set changes (same-condition workflow).
      $("conditionSelect")?.classList.remove("needs-input");
      if (State.selectedSetName) $("setSelect")?.classList.remove("needs-input");
      status($("confirmPickStatus"), rarities.length ? "Select a rarity → condition, then enter quantity." : "No rarities found.");
      enableQtyIfReady();
    });

    $("raritySelect")?.addEventListener("change", () => {
      State.selectedRarity = $("raritySelect").value || null;
      State.selectedPrinting = (State.selectedRarity && State.selectedSetName)
        ? (State.selectedCard?.sets||[]).find(p => p.set_name === State.selectedSetName && p.set_rarity === State.selectedRarity) || null
        : null;
      // v13.4 (Sprint 2, #5): preserve Condition across rarity changes (was being wiped).
      $("conditionSelect")?.classList.remove("needs-input");
      if (State.selectedRarity) $("raritySelect")?.classList.remove("needs-input");
      status($("confirmPickStatus"), State.selectedPrinting ? "Pick a condition, then enter quantity." : "No printing found.");
      enableQtyIfReady();
    });

    $("conditionSelect")?.addEventListener("change", () => {
      State.selectedCondition = $("conditionSelect").value || null;
      status($("confirmPickStatus"), State.selectedCondition ? "Enter quantity, then Confirm Card." : "Pick a condition.");
      enableQtyIfReady();
    });

    $("qty")?.addEventListener("input", enableQtyIfReady);

    // v10.2: re-evaluate the Post button as the user edits the name fields.
    //        ocrName is read-only and updated programmatically, so also watch
    //        for attribute-value mutations on it.
    $("manualName")?.addEventListener("input", enableQtyIfReady);
    const _ocr = $("ocrName");
    if (_ocr) {
      _ocr.addEventListener("input", enableQtyIfReady);
      try {
        new MutationObserver(enableQtyIfReady)
          .observe(_ocr, { attributes: true, attributeFilter: ["value"] });
      } catch (_) {}
    }
  }

  window.UI.lookup = { bind };
})();
