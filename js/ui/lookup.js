// js/ui/lookup.js
(function(){
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

  // (kept for reference; not used for gating anymore)
  async function ensureExactDbNameOrNull(name){
    const q = (name || "").trim();
    if (!q) return null;
    try{
      const list = await Lookup.fetchCandidates(q);
      if (!Array.isArray(list) || !list.length) return null;
      const lower = q.toLowerCase();
      for (const c of list){
        const n = c?.name ? String(c.name) : "";
        if (n && n.toLowerCase() === lower) return n;
      }
      return null;
    } catch(e){
      console.error("ensureExactDbNameOrNull error:", e);
      return null;
    }
  }

  function bind(){
    $("lookupBtn")?.addEventListener("click", async () => {
      const chosen = currentName();
      if (!chosen.text) { status($("lookupStatus"), "Enter or scan a card first.", true); return; }

      // Always pause/prepare UI for lookup
      resetFlowForNewPick();
      try { window.Scanner.pause(); window.UI.showResume(true); $("autoStatus").textContent = "Scanning paused (lookup)…"; } catch (_) { }
      status($("lookupStatus"), `Searching YGOPRODeck…`);
      $("setSelect").innerHTML = ""; $("raritySelect").innerHTML = "";
      if ($("conditionSelect")) $("conditionSelect").value = "";
      State.selectedCard = State.selectedPrinting = State.selectedSetName = State.selectedRarity = State.selectedCondition = null;

      try {
        // For MANUAL: accept fuzzy (≥65%) using resolver; lock to canonical name if confident.
        if (chosen.source === "manual") {
          const canonical = await Lookup.resolveNameFromScanNgrams(chosen.text); // returns "" if score < 0.65
          if (!canonical) {
            status($("lookupStatus"), "Couldn’t confidently match that name (≥65%). Refine or pick from suggestions.", true);
            return;
          }
          $("manualName").value = canonical; // lock the textbox to the exact DB name
          chosen.text = canonical;
          $("autoStatus").textContent = "Scanning paused (name locked)…";
        }

        // Fetch candidates (cached) and pick the best/locked one
        const candidates = await Lookup.fetchCandidates(chosen.text);
        if (!candidates.length) { status($("lookupStatus"), "No matches found.", true); return; }

        // Prefer exact candidate if our text is canonical now; otherwise best match
        const lower = chosen.text.toLowerCase();
        let pick = candidates.find(c => (c?.name || "").toLowerCase() === lower);
        if (!pick) {
          const idx = Lookup.bestNameMatch(chosen.text, candidates);
          pick = (idx >= 0) ? candidates[idx] : null;
        }
        if (!pick) { status($("lookupStatus"), "No confident match.", true); return; }

        State.selectedCard = pick;

        // Build Set dropdown from the chosen card's printings
        const sets = [...new Set((State.selectedCard.sets||[]).map(p=>p.set_name).filter(Boolean))];
        const setSel = $("setSelect"); setSel.innerHTML = "";
        const ph = document.createElement("option"); ph.value = ""; ph.textContent = "please select"; ph.disabled = true; setSel.appendChild(ph);
        sets.forEach(n => { const o = document.createElement("option"); o.value = n; o.textContent = n; setSel.appendChild(o); });
        setSel.value = "";

        // Prepare rarity select
        const rarSel = $("raritySelect"); rarSel.innerHTML = "";
        const ph2 = document.createElement("option"); ph2.value = ""; ph2.textContent = "please select"; ph2.disabled = true; rarSel.appendChild(ph2);
        rarSel.value = "";

        status($("lookupStatus"), `Found ${candidates.length} match(es).`);
        status($("confirmPickStatus"), "Select set → rarity → condition, then enter quantity.");
        enableQtyIfReady();
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
      status($("confirmPickStatus"), rarities.length ? "Select a rarity → condition, then enter quantity." : "No rarities found.");
      enableQtyIfReady();
    });

    $("raritySelect")?.addEventListener("change", () => {
      State.selectedRarity = $("raritySelect").value || null;
      State.selectedPrinting = (State.selectedRarity && State.selectedSetName)
        ? (State.selectedCard?.sets||[]).find(p => p.set_name === State.selectedSetName && p.set_rarity === State.selectedRarity) || null
        : null;
      State.selectedCondition = null; $("conditionSelect").value = "";
      status($("confirmPickStatus"), State.selectedPrinting ? "Pick a condition, then enter quantity." : "No printing found.");
      enableQtyIfReady();
    });

    $("conditionSelect")?.addEventListener("change", () => {
      State.selectedCondition = $("conditionSelect").value || null;
      status($("confirmPickStatus"), State.selectedCondition ? "Enter quantity, then Confirm Card." : "Pick a condition.");
      enableQtyIfReady();
    });

    $("qty")?.addEventListener("input", enableQtyIfReady);
  }

  window.UI.lookup = { bind };
})();
