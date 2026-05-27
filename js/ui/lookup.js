// js/ui/lookup.js  — v10.4
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

  // v9.2: shared populate helper so safety-net path reuses identical logic
  function populateSetDropdown() {
    const setSel = $("setSelect");
    if (!setSel) return;
    const sets = [...new Set((State.selectedCard?.sets || []).map(p => p.set_name).filter(Boolean))];
    setSel.innerHTML = "";
    const ph = document.createElement("option");
    ph.value = ""; ph.textContent = "please select"; ph.disabled = true;
    setSel.appendChild(ph);
    sets.forEach(n => {
      const o = document.createElement("option");
      o.value = n; o.textContent = n;
      setSel.appendChild(o);
    });
    setSel.value = "";
    if (sets.length > 0) setSel.classList.add("needs-input");
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
      if ($("conditionSelect")) $("conditionSelect").value = "";
      State.selectedCard = State.selectedPrinting = State.selectedSetName = State.selectedRarity = State.selectedCondition = null;

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

        const rarSel = $("raritySelect"); rarSel.innerHTML = "";
        const ph2 = document.createElement("option"); ph2.value = ""; ph2.textContent = "please select"; ph2.disabled = true; rarSel.appendChild(ph2);
        rarSel.value = "";

        status($("lookupStatus"), `Found ${candidates.length} match(es).`);
        status($("confirmPickStatus"), "Select set → rarity → condition, then enter quantity.");
        enableQtyIfReady();

        // v9.2: SAFETY NET — if the picked candidate landed with empty sets
        // (the synthetic local-only path from api.js, or some other gap),
        // fetch them now and repopulate the dropdown. This guarantees the
        // user gets a real set/rarity choice whenever YGOPRODeck is healthy.
        const currentSets = Array.isArray(State.selectedCard.sets) ? State.selectedCard.sets : [];
        const needsFill = currentSets.length === 0 || pick.__synthetic === true;
        if (needsFill && typeof window.Lookup?.fillSetsForCandidate === "function") {
          status($("lookupStatus"), `Found ${candidates.length} match(es). Fetching printings (may scan recent sets if API is slow)…`);
          try {
            const ok = await window.Lookup.fillSetsForCandidate(State.selectedCard);
            if (ok && Array.isArray(State.selectedCard.sets) && State.selectedCard.sets.length) {
              populateSetDropdown();
              status($("lookupStatus"), `Found ${candidates.length} match(es). ✓ ${State.selectedCard.sets.length} printing(s) loaded.`);
            } else {
              // v10.2: name is sufficient — don't demand a set code. Inform the
              //        user that printings couldn't be fetched but they can
              //        still post with just the name (and condition/qty).
              status($("lookupStatus"), `Found ${candidates.length} match(es). ⚠ Couldn't load printings — set code is optional; pick a Condition and Post to Sheet.`, true);
              enableQtyIfReady();
            }
          } catch (e) {
            // CONSOLE-OFF v12 console.warn('[lookup] sets safety-net threw:', e);
            status($("lookupStatus"), `Found ${candidates.length} match(es). ⚠ Couldn't load printings — set code is optional; pick a Condition and Post to Sheet.`, true);
            enableQtyIfReady();
          }
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
      const ph = document.createElement("option"); ph.value = ""; ph.textContent = "please select"; ph.disabled = true; rarSel.appendChild(ph);
      rarities.forEach(r => { const o = document.createElement("option"); o.value = r; o.textContent = r; rarSel.appendChild(o); });
      rarSel.value = "";
      State.selectedRarity = State.selectedPrinting = null; State.selectedCondition = null; $("conditionSelect").value = "";
      if (State.selectedSetName) $("setSelect")?.classList.remove("needs-input");
      status($("confirmPickStatus"), rarities.length ? "Select a rarity → condition, then enter quantity." : "No rarities found.");
      enableQtyIfReady();
    });

    $("raritySelect")?.addEventListener("change", () => {
      State.selectedRarity = $("raritySelect").value || null;
      State.selectedPrinting = (State.selectedRarity && State.selectedSetName)
        ? (State.selectedCard?.sets||[]).find(p => p.set_name === State.selectedSetName && p.set_rarity === State.selectedRarity) || null
        : null;
      State.selectedCondition = null; $("conditionSelect").value = "";
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
