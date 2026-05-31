// js/ui/confirm.js — v14.1
// Fix 1: Success modal shows "Inventory total" row when card already existed (merged).
// Fix 2: postCurrentSelection exposed on window.UI so captureConfirmBtn can post
//        directly without re-opening codeConfirmModal (no double-confirm).
// Fix 3: validateRow highlights ALL unfilled dropdowns (set, rarity, condition)
//        via window.UI.cue.fireNeedsInput + manual cue-needs-input class on the rest.
// Fix 4: confirmBtn click gate runs validateRow BEFORE opening codeConfirmModal;
//        the modal never opens with missing fields.
//
// v14.0 (EPIC-93): unified confirm UX — art-forward modal, card-select popup, cue system.
//
// v13.4 changes (Sprint 1 — closes #3, #4, #20, #21, #22):
//   • Issue #3 (v18 PRICE-OFF): no price line in the success modal markup.
//     Apps Script price column on the Sheet remains untouched.
//   • Issue #4: row-number references stripped from both the success modal
//     body and the status line. Backend still receives + logs `result.row`.
//   • Issue #20 (UAT follow-up): Recent Items table Price column removed.
//     `appendToRecentGrid()` no longer emits a `<td class="price">` cell
//     and the dedup-merge qty index moved from tds[5] → tds[5] (unchanged
//     since Qty was column 6 — still index 5 — but cell count is now 7).
//   • Issue #21 (UAT follow-up): redundant "Added as new row" /
//     "Merged into existing row" inner banner removed. Modal title
//     ("Added to Sheet") + the card details line are sufficient. Merge-
//     vs-new signal moved inline into the card line as `(merged × N)`
//     when a merge happens; otherwise unadorned.
//   • Issue #22 (UAT follow-up): × close button removed from the success
//     modal header (index.html). OK button + Esc + backdrop-click remain.
//     Fallback handler in openSuccessModal() now uses optional chaining so
//     the missing element doesn't throw.
//
// v10.2 changes:
//   • validateRow() relaxed: name + condition + qty are now the ONLY required
//     fields. Set / Rarity / Code are all optional. Posting a name-only row
//     is supported when YGOPRODeck can't return printings.
//
// v10.1 changes:
//   • After a successful post, dispatch `inventory:form:reset` AFTER calling
//     resetForm() (unchanged) — scan.js now listens for this event and:
//        - pauses the scanner so it doesn't re-detect the same card
//        - calls clearFormAndState() to wipe ocrName/captureBar/State/etc.
//        - flips the toggle to "Resume Scanning"
//     The old reset path only cleared the form fields owned by confirm.js,
//     which is why the Scanned Name + Accept bar persisted after save.
//
// v10 changes:
//   • sendToSheet() now returns {merged, newQty} on duplicate-merge.
//     Success modal + status bar + recent-grid bump now reflect this:
//     "Merged into row N (qty: X)" vs "Added row N".
//
// v8.2 (preserved):
//
// POST BUG FIX (v8.2):
//   Root cause: openSuccessModal() was calling successModal.classList.remove("hidden")
//   which has no effect — successModal has class="modal" and CSS requires ".modal.is-open"
//   to display it. The .is-open class was never added, so the success modal was always
//   invisible. The POST itself succeeded (row reached the sheet) but the user saw no
//   confirmation and the form silently reset, making it appear that posting was broken.
//
//   Fix: route success modal open/close through window.UI.modal.open() / .close(),
//   which correctly adds/removes .is-open. modal.js is loaded before confirm.js and
//   sets window.UI.modal synchronously in its IIFE, so it is always available here.
//
//   All other POST logic (field names, payload shape, fetch mode, secret, URL) is
//   IDENTICAL to v6 (last known-good). No structural changes.
//
// Other v8.2 changes:
//   • Persists condition + qty to localStorage (carried forward from v8.1).
//   • resetForm() restores qty from localStorage instead of resetting to 1.
//   • Version log changed to v8.2.

(function () {
  "use strict";

  // ---- Element helpers ----
  // Use querySelector so this works regardless of $ alias availability.
  const $ = (sel) => document.querySelector(sel);
  const ocrNameEl    = $("#ocrName");
  const manualNameEl = $("#manualName");
  const setSel       = $("#setSelect");
  const raritySel    = $("#raritySelect");
  const qtyEl        = $("#qty");
  const conditionSel = $("#conditionSelect");
  const confirmBtn   = $("#confirmBtn");
  const confirmStatus = $("#confirmPickStatus") || $("#confirmStatus");

  // Shared state (populated by state.js which loads before confirm.js)
  const UI    = (window.UI    = window.UI    || {});
  const State = (UI.State     = UI.State     || {});

  // Code-confirm modal elements
  const codeModal              = $("#codeConfirmModal");
  const codeConfirmText        = $("#codeConfirmText");           // legacy (kept hidden in v13)
  const codeConfirmCloseX      = $("#codeConfirmCloseX");
  const codeConfirmCancelBtn   = $("#codeConfirmCancelBtn");
  const codeConfirmConfirmBtn  = $("#codeConfirmConfirmBtn");
  // v13: art-forward card preview targets
  const codeConfirmArt         = $("#codeConfirmArt");
  const codeConfirmNameEl      = $("#codeConfirmName");
  const codeConfirmSetEl       = $("#codeConfirmSet");
  const codeConfirmCodeEl      = $("#codeConfirmCode");
  const codeConfirmRarityEl    = $("#codeConfirmRarity");
  const codeConfirmQtyEl       = $("#codeConfirmQty");
  const codeConfirmConditionEl = $("#codeConfirmCondition");

  // Recent grid
  const gridBody = document.querySelector("#grid tbody");

  // ---- Condition options (single source of truth) — v16 (#42) ----------------
  // The Condition <select> was previously static HTML in index.html. After a
  // successful post, resetForm()'s resetSelect() destroyed every <option> and
  // re-appended ONLY options[0] (the placeholder), so the real condition
  // choices (NM/LP/MP/HP/D) vanished on the 2nd card and stayed gone until a
  // full page reload. Unlike Set/Rarity (which repopulate from the next
  // lookup), Condition has no repopulate path — its values are constant.
  //
  // Fix: drive Condition from this constant array via populateConditionSelect()
  // and call it both on init AND on reset, so the dropdown always has its full
  // option list regardless of how many cards have been posted in a row.
  const CONDITIONS = [
    { value: "NM", label: "NM" },
    { value: "LP", label: "LP" },
    { value: "MP", label: "MP" },
    { value: "HP", label: "HP" },
    { value: "D",  label: "D"  },
  ];

  // Rebuild the Condition <select> from CONDITIONS, preserving the leading
  // "please select" placeholder. Optionally restore a previously-selected value.
  function populateConditionSelect(keepValue) {
    if (!conditionSel) return;
    const prev = (typeof keepValue === "string") ? keepValue : "";
    conditionSel.innerHTML = "";
    const ph = document.createElement("option");
    ph.value = "";
    ph.textContent = "please select";
    conditionSel.appendChild(ph);
    CONDITIONS.forEach(c => {
      const o = document.createElement("option");
      o.value = c.value;
      o.textContent = c.label;
      conditionSel.appendChild(o);
    });
    // Restore a real prior selection if it still exists; else placeholder.
    if (prev && CONDITIONS.some(c => c.value === prev)) {
      conditionSel.value = prev;
    } else {
      conditionSel.selectedIndex = 0;
    }
  }

  // Submit guard — prevents double-posting on rapid clicks
  let inFlight = false;

  // ---- Select value helpers ----
  function getSelectedOption(selectEl) {
    if (!selectEl || !selectEl.options) return null;
    const idx = typeof selectEl.selectedIndex === "number" ? selectEl.selectedIndex : -1;
    if (idx < 0 || idx >= selectEl.options.length) return null;
    return selectEl.options[idx] || null;
  }
  function getSelectedText(selectEl) {
    return getSelectedOption(selectEl)?.textContent?.trim?.() ?? "";
  }
  function getSelectedValue(selectEl) {
    return (getSelectedOption(selectEl)?.value ?? "").toString().trim();
  }
  function extractCodeFromOption(optText) {
    const m = optText && optText.match(/\(([A-Za-z0-9\-]+)\)\s*$/);
    return m ? m[1] : "";
  }

  // ---- Status ----
  function showStatus(msg, kind = "info") {
    if (!confirmStatus) return;
    confirmStatus.textContent = msg;
    confirmStatus.className = "status " + (kind === "error" ? "error" : kind === "ok" ? "ok" : "");
  }

  // ---- Success modal — EPIC-93 Story #95: art-forward .cc-card layout (AC-001 / AC-008) ----
  // Builds the same .cc-card markup used by #codeConfirmModal so all three
  // confirmation surfaces share one visual language. Delegates open/close to
  // modal.js for .is-open toggling, focus management, and scan-resume (AC-008).
  function _buildSuccessCardHtml(row, isMerged, mergedQty) {
    const cardId = State?.selectedPrinting?.id || State?.selectedCard?.id || null;
    const imgUrl = State?.selectedPrinting?.imageUrl
                || (cardId ? `https://images.ygoprodeck.com/images/cards/${cardId}.jpg` : null);
    const artTag = imgUrl
      ? `<img class="cc-art" src="${imgUrl}" alt="${row.name}" onerror="this.style.display='none'" />`
      : `<div class="cc-art cc-art--missing" aria-hidden="true"></div>`;
    const mergeTag = isMerged
      ? `<span class="merge-tag">+${row.qty} merged</span>`
      : "";
    // Fix 1: show inventory total line only when the card already existed in the sheet
    const totalLine = (isMerged && Number.isFinite(mergedQty))
      ? `<div class="cc-row cc-row--total"><span class="cc-label">Inventory total</span><span class="cc-value cc-total">${mergedQty}</span></div>`
      : "";
    return `
      <div class="cc-card">
        ${artTag}
        <div class="cc-info">
          <div class="cc-name">${row.name} ${mergeTag}</div>
          <div class="cc-row"><span class="cc-label">Set</span><span class="cc-value">${row.set || "\u2014"}</span></div>
          <div class="cc-row"><span class="cc-label">Code</span><span class="cc-value cc-code">${row.code || "\u2014"}</span></div>
          <div class="cc-row"><span class="cc-label">Rarity</span><span class="cc-value">${row.rarity || "\u2014"}</span></div>
          <div class="cc-row"><span class="cc-label">Qty added</span><span class="cc-value">${row.qty}</span></div>
          <div class="cc-row"><span class="cc-label">Condition</span><span class="cc-value">${row.condition || "\u2014"}</span></div>
          ${totalLine}
        </div>
      </div>`;
  }

  function openSuccessModal(cardHtml) {
    try { window.UI?.cue?.clearCues?.(); } catch (_) {}
    if (window.UI?.modal?.open) {
      window.UI.modal.open(cardHtml || "Added.");
    } else {
      const m = document.getElementById("successModal");
      const body = document.getElementById("successModalBody");
      if (!m) return;
      if (body) body.innerHTML = cardHtml || "Added.";
      m.classList.add("is-open");
      m.setAttribute("aria-hidden", "false");
      m.querySelector(".modal__ok")?.addEventListener("click", closeSuccessModal, { once: true });
    }
  }

  // modal.js.close() removes .is-open and resumes scanning (AC-008).
  function closeSuccessModal() {
    try { window.UI?.cue?.clearCues?.(); } catch (_) {}
    if (window.UI?.modal?.close) {
      window.UI.modal.close();
    } else {
      const m = document.getElementById("successModal");
      if (!m) return;
      if (window.UI?.moveFocusOutOf) window.UI.moveFocusOutOf(m);
      else if (m.contains(document.activeElement)) { try { document.activeElement.blur(); } catch (_) {} }
      m.classList.remove("is-open");
      m.setAttribute("aria-hidden", "true");
    }
  }

  // ---- Code-confirm modal (v13: art-forward card preview) -------------------
  // Populates the card-style modal with art on the left and name/set/code/
  // rarity/qty/condition rows on the right. Pulls data from State (selected
  // printing/card) and the live form fields so a single call site keeps
  // working without re-routing data through the caller.
  function openCodeConfirmModal(codePreview) {
    if (!codeModal) return;

    const printing = State?.selectedPrinting || {};
    const card     = State?.selectedCard     || {};
    const name     = (manualNameEl?.value || "").trim() || (ocrNameEl?.value || "").trim() || card.name || "—";
    const setName  = State?.selectedSetName  || getSelectedValue(setSel)    || getSelectedText(setSel)    || "—";
    const rarity   = State?.selectedRarity   || getSelectedValue(raritySel) || getSelectedText(raritySel) || "—";
    const code     = printing.set_code || codePreview || extractCodeFromOption(getSelectedText(setSel)) || "—";
    const qty      = (qtyEl?.value || "1").trim() || "1";
    const condition = getSelectedValue(conditionSel) || getSelectedText(conditionSel) || "—";

    // Image URL: prefer explicit imageUrl, then derive from id, else hide image.
    const cardId   = printing.id || card.id || null;
    const imgUrl   = printing.imageUrl
                  || (cardId ? `https://images.ygoprodeck.com/images/cards/${cardId}.jpg` : null);

    if (codeConfirmArt) {
      if (imgUrl) {
        codeConfirmArt.src     = imgUrl;
        codeConfirmArt.alt     = name;
        codeConfirmArt.style.display = "";
        codeConfirmArt.onerror = function () { this.style.display = "none"; };
      } else {
        codeConfirmArt.removeAttribute("src");
        codeConfirmArt.style.display = "none";
      }
    }
    if (codeConfirmNameEl)      codeConfirmNameEl.textContent      = name;
    if (codeConfirmSetEl)       codeConfirmSetEl.textContent       = setName;
    if (codeConfirmCodeEl)      codeConfirmCodeEl.textContent      = code;
    if (codeConfirmRarityEl)    codeConfirmRarityEl.textContent    = rarity;
    if (codeConfirmQtyEl)       codeConfirmQtyEl.textContent       = qty;
    if (codeConfirmConditionEl) codeConfirmConditionEl.textContent = condition;

    // Keep the legacy hidden text node in sync in case anything else reads it.
    if (codeConfirmText) codeConfirmText.textContent = "Confirm Card Code: " + (codePreview || "(none)");

    codeModal.classList.remove("hidden");
    codeModal.setAttribute("aria-hidden", "false");
  }
  function closeCodeConfirmModal() {
    if (!codeModal) return;
    // v16 (#27): the flagged violation was <button#codeConfirmConfirmBtn>
    // retaining focus inside <div#codeConfirmModal> at the moment we set
    // aria-hidden="true". Move focus OUT first via the shared helper (which
    // reliably parks focus on <body>), THEN hide. Falls back to a plain blur
    // if the helper isn't present.
    if (window.UI?.moveFocusOutOf) window.UI.moveFocusOutOf(codeModal);
    else if (codeModal.contains(document.activeElement)) { try { document.activeElement.blur(); } catch (_) {} }
    codeModal.classList.add("hidden");
    codeModal.setAttribute("aria-hidden", "true");
  }

  // ---- Build row from current UI state ----
  // Field names and shape are IDENTICAL to v6 (last known-good posting version).
  // price is intentionally left blank.
  function buildRowFromUI() {
    const name     = (manualNameEl?.value || "").trim() || (ocrNameEl?.value || "").trim();
    const setName  = State?.selectedSetName  || getSelectedValue(setSel)    || getSelectedText(setSel);
    const rarity   = State?.selectedRarity   || getSelectedValue(raritySel) || getSelectedText(raritySel);
    const printing = State?.selectedPrinting || null;

    let code = printing?.set_code || "";
    if (!code) code = extractCodeFromOption(getSelectedText(setSel));

    const qty       = parseInt(qtyEl?.value || "1", 10) || 1;
    const condition = getSelectedValue(conditionSel) || getSelectedText(conditionSel);

    return {
      timestamp: new Date().toISOString(),
      name,
      set:       setName    || "",
      code:      code       || "",
      rarity:    rarity     || "",
      condition: condition  || "",
      qty,
      price:     "",              // intentionally blank — Apps Script fills this
      source:    "Logan's Desktop",
    };
  }

  // ---- Validate row + highlight ALL missing fields (Fix 3 + Fix 4) ----
  // Returns an error string if any required field is missing, null if OK.
  // Also fires cue.fireNeedsInput() on EVERY unfilled dropdown so the user
  // can see at a glance exactly what still needs attention.
  function validateRow(row) {
    const missing = []; // collect all defects before deciding what to highlight

    if (!row.name) missing.push("name");

    // Set and Rarity are required whenever the card was looked up via the
    // database path (State.selectedPrinting populated). For manual-name-only
    // entries they remain optional (same leniency as before).
    const hasResolvedPrinting = !!(State?.selectedPrinting || State?.selectedSetName);
    if (hasResolvedPrinting && !row.set)    missing.push("set");
    if (hasResolvedPrinting && !row.rarity) missing.push("rarity");

    if (!row.condition) missing.push("condition");
    if (!row.qty || row.qty < 1) missing.push("qty");

    if (missing.length === 0) return null;

    // Fire cue highlights on ALL missing dropdowns (Fix 3)
    try {
      const cue = window.UI?.cue;
      if (cue) {
        // fireNeedsInput only takes one element, so call it on the most
        // important missing field first; then add the amber ring class
        // manually to the others (clearCues will remove them all at once).
        const fieldMap = { set: setSel, rarity: raritySel, condition: conditionSel, qty: qtyEl };
        const missingEls = missing.map(k => fieldMap[k]).filter(Boolean);
        // Primary cue fires tone + ring on first el, then we add rings to the rest
        if (missingEls[0]) cue.fireNeedsInput(missingEls[0]);
        missingEls.slice(1).forEach(el => el.classList.add("cue-needs-input"));
      }
    } catch (_) {}

    // Return first human-readable error message
    if (missing.includes("name"))      return "Please enter a card name.";
    if (missing.includes("set"))       return "Please select a Set.";
    if (missing.includes("rarity"))    return "Please select a Rarity.";
    if (missing.includes("condition")) return "Please choose a Condition.";
    if (missing.includes("qty"))       return "Quantity must be at least 1.";
    return "Please fill out all required fields.";
  }

  // ---- Append to recent-items grid (de-duped by name+set+code+rarity+condition) ----
  function appendToRecentGrid(row) {
    if (!gridBody) return;
    const norm = (s) => (s ?? "").toString().trim();
    const key = [norm(row.name), norm(row.set), norm(row.code || ""), norm(row.rarity), norm(row.condition || "")].join("||");

    for (const tr of Array.from(gridBody.querySelectorAll("tr"))) {
      const tds = tr.children;
      if (tds.length < 6) continue;
      const existingKey = [norm(tds[0].textContent), norm(tds[1].textContent), norm(tds[2].textContent), norm(tds[3].textContent), norm(tds[4].textContent)].join("||");
      if (existingKey === key) {
        const current = parseInt(norm(tds[5].textContent) || "0", 10) || 0;
        tds[5].textContent = String(current + (parseInt(row.qty, 10) || 0));
        const statusCell = tds[tds.length - 1];
        if (statusCell) statusCell.textContent = "✅";
        return;
      }
    }

    const tr = document.createElement("tr");
    // v20: Price cell removed. Columns are now
    //   0:Name | 1:Set | 2:Code | 3:Rarity | 4:Condition | 5:Qty | 6:Sent?
    tr.innerHTML = `
      <td>${row.name}</td>
      <td>${row.set}</td>
      <td>${row.code || ""}</td>
      <td>${row.rarity}</td>
      <td>${row.condition}</td>
      <td>${row.qty}</td>
      <td>✅</td>`;
    gridBody.prepend(tr);
  }

  // ---- Reset form after a successful post ----
  function resetForm() {
    function resetSelect(sel) {
      if (!sel) return;
      // #86 (EPIC-87, AC-002/AC-003): rebuild a fresh "please select" placeholder
      //   instead of reusing sel.options[0]. During a scan, populateSetDropdown()
      //   and the code-match path do `innerHTML = ""` and rebuild the option list,
      //   so options[0] may be a real set/rarity name (not the placeholder) by the
      //   time we reset. Reusing it left the Set/Rarity dropdowns BLANK on the next
      //   card. Always emit the canonical placeholder shape here, matching the
      //   makePlaceholder() factory in lookup.js.
      while (sel.firstChild) sel.removeChild(sel.firstChild);
      const ph = document.createElement("option");
      ph.value = "";
      ph.textContent = "please select";
      ph.disabled = true;
      ph.selected = true;
      sel.appendChild(ph);
      sel.disabled = false;
      if (sel.dataset) sel.dataset.populated = "0";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }

    if (manualNameEl) manualNameEl.value = "";
    if (ocrNameEl)    ocrNameEl.value    = "";

    // v24 (#26): full form reset after successful post — match fresh-page-load state.
    // Previously qty was restored from localStorage and Condition was preserved for the
    // same-condition rapid-scan flow. After #24 unified placeholders to 'please select'
    // on initial load, leaving Condition populated post-success read inconsistently.
    // Now: qty resets to 1, Condition resets to placeholder, State.selectedCondition cleared.
    if (qtyEl) qtyEl.value = "1";

    resetSelect(setSel);
    resetSelect(raritySel);
    // v16 (#42): Condition is NOT a dynamic select — rebuild it from the
    // constant CONDITIONS list instead of letting resetSelect() strip every
    // option down to the placeholder (which left it empty on the 2nd card).
    populateConditionSelect();

    State.selectedSetName   = null;
    State.selectedRarity    = null;
    State.selectedPrinting  = null;
    State.selectedCondition = null;

    if (confirmBtn) confirmBtn.disabled = true;
    const ocrConf      = document.getElementById("ocrConf");      if (ocrConf)      ocrConf.textContent      = "accuracy: —";
    const ocrStatus    = document.getElementById("ocrStatus");    if (ocrStatus)    ocrStatus.textContent    = "";
    const lookupStatus = document.getElementById("lookupStatus"); if (lookupStatus) lookupStatus.textContent = "";
    showStatus("");

    // Clear any .needs-input highlights
    document.querySelectorAll(".needs-input").forEach(el => el.classList.remove("needs-input"));

    // Hide capture confirm bar
    const captureBar = document.getElementById("captureConfirmBar");
    if (captureBar) captureBar.style.display = "none";

    // Hide match-source bar
    const msBar = document.getElementById("matchSourceBar");
    if (msBar) msBar.style.display = "none";

    document.dispatchEvent(new CustomEvent("inventory:form:reset"));
  }

  // ---- Core POST routine ----
  async function postCurrentSelection() {
    if (inFlight) return;
    inFlight = true;
    if (confirmBtn) confirmBtn.disabled = true;
    showStatus("Posting…");

    try {
      const row = buildRowFromUI();
      const err = validateRow(row);
      if (err) {
        showStatus(err, "error");
        // CONSOLE-OFF v12 console.warn("[confirm] validation failed:", err, row);
        return;   // finally block re-enables inFlight=false
      }

      if (!window.Sheet || typeof window.Sheet.sendToSheet !== "function") {
        console.error("[confirm] Sheet.sendToSheet() not available — check config.js and sheetsClient.js load order.");
        showStatus("Cannot post: Sheets client not ready.", "error");
        return;
      }

      // CONSOLE-OFF v12 console.log("[confirm] posting row:", row);
      // v9.3: sendToSheet now returns { ok, row?, error? } instead of fire-and-forget.
      // Only show "Added to Sheet" modal on real success; otherwise surface the error.
      const result = await window.Sheet.sendToSheet(row);

      if (!result || result.ok !== true) {
        const errMsg = (result && result.error) || "unknown error";
        console.error("[confirm] post failed:", errMsg, result);
        showStatus("✗ Post failed: " + errMsg, "error");
        return; // do NOT append to recent grid, do NOT reset form, do NOT show success modal
      }

      // v10: when the backend merged into an existing row, prefer the merged
      // qty so the recent grid stays in sync with the sheet's actual quantity.
      const isMerged = result.merged === true;
      const displayRow = { ...row };
      if (isMerged && Number.isFinite(result.newQty)) {
        // recent-grid is keyed the same way; bumping by the addedQty matches
        // the user's intent and what the sheet just did.
        displayRow.qty = result.addedQty ?? row.qty;
      }
      appendToRecentGrid(displayRow);

      // Persist condition + qty for next card
      try { State.savePersistedCondition?.(row.condition || ""); } catch (_) {}
      try { State.savePersistedQty?.(row.qty);                   } catch (_) {}

      // Show success modal — v8.2 fix: uses modal.js.open() → adds .is-open correctly
      // v13.4 (#4): no row-number reference. Backend still returns result.row;
      //             we just don't render it.
      // v13.4 (#21): redundant "Added as new row" / "Merged into existing
      //              row" banner removed. The modal title says "Added to
      //              Sheet"; merge vs new is signaled inline on the card
      //              line as `(merged × N)` when applicable.
      // v13.4 (#3 — v18 PRICE-OFF):
      //   Intentionally NO price line rendered in the success modal.
      // EPIC-93 Story #95 (AC-001): success modal now renders the art-forward
      // .cc-card layout, matching the codeConfirmModal visual language.
      openSuccessModal(_buildSuccessCardHtml(row, isMerged, result.newQty));

      resetForm();
      // v13.4 (Sprint 1, #4): drop row-N from status text. Keep merged-vs-new
      // distinction since it's still useful UX signal about backend behavior.
      if (isMerged) {
        showStatus(
          "✓ Merged into existing row (qty: " + result.newQty + "). Ready for next card.",
          "ok"
        );
      } else {
        showStatus(
          "✓ Added to sheet. Ready for next card.",
          "ok"
        );
      }
    } catch (e) {
      console.error("[confirm] post failed:", e);
      showStatus("Failed to post. See console.", "error");
    } finally {
      inFlight = false;
    }
  }

  // ---- Wire up code-confirm modal buttons ----
  codeConfirmConfirmBtn?.addEventListener("click", async () => {
    closeCodeConfirmModal();
    await postCurrentSelection();
  });
  codeConfirmCancelBtn?.addEventListener("click", () => {
    closeCodeConfirmModal();
    showStatus("Canceled.", "info");
    if (confirmBtn) confirmBtn.disabled = false; // re-enable so user can try again
  });
  codeConfirmCloseX?.addEventListener("click", () => {
    closeCodeConfirmModal();
    if (confirmBtn) confirmBtn.disabled = false;
  });

  // ---- Primary Post to Sheet button (Fix 4: validation gate) ----
  // Run validateRow BEFORE opening codeConfirmModal so the modal only opens
  // when the form is complete. Highlights all missing fields via cue (Fix 3).
  confirmBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    if (inFlight) return;

    // Gate: validate all required fields first
    const row = buildRowFromUI();
    const gateErr = validateRow(row);
    if (gateErr) {
      showStatus(gateErr, "error");
      return;
    }

    const previewCode = State?.selectedPrinting?.set_code || extractCodeFromOption(getSelectedText(setSel));
    if (codeModal) {
      openCodeConfirmModal(previewCode);
    } else {
      postCurrentSelection();
    }
  });

  if (confirmBtn) confirmBtn.disabled = true;

  // v16 (#42): populate Condition from the constant list on initial load.
  populateConditionSelect();

  // EPIC-93: expose openCodeConfirmModal so scan.js can call
  // window.UI.openCodeConfirmModal() (captureConfirmBtn path).
  UI.openCodeConfirmModal = openCodeConfirmModal;

  // Fix 2: expose postCurrentSelection so captureConfirmBtn can post
  // directly when all fields are already filled (no double-confirm).
  UI.postCurrentSelection = postCurrentSelection;
})();
