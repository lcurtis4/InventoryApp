// js/ui/confirm.js — v13.4 (Sprint 1: success-modal polish)
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

  // ---- Success modal — v8.2 fix: use modal.js open/close ----
  // modal.js sets window.UI.modal in its IIFE (before this file runs).
  // modal.js.open() adds ".is-open" class which makes .modal.is-open { display:block }
  // work correctly in style.css.
  function openSuccessModal(messageHtml) {
    if (window.UI?.modal?.open) {
      // Preferred path: delegate to modal.js which handles .is-open, focus, scroll lock, etc.
      window.UI.modal.open(messageHtml || "Added.");
    } else {
      // Fallback: directly add .is-open if modal.js failed to load for any reason
      const m = document.getElementById("successModal");
      const body = document.getElementById("successModalBody");
      if (!m) return;
      if (body) body.innerHTML = messageHtml || "Added.";
      m.classList.add("is-open");
      m.setAttribute("aria-hidden", "false");
      // Wire close button manually in case modal.js init() didn't run.
      // v22: × button removed from header; OK is the only close affordance now.
      const closeOnce = () => closeSuccessModal();
      m.querySelector(".modal__ok")?.addEventListener("click", closeOnce, { once: true });
    }
  }
  // modal.js.close() removes .is-open and resumes scanning.
  function closeSuccessModal() {
    if (window.UI?.modal?.close) {
      window.UI.modal.close();
    } else {
      const m = document.getElementById("successModal");
      if (!m) return;
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
    codeModal?.classList.add("hidden");
    codeModal?.setAttribute("aria-hidden", "true");
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

  // ---- Validate row before posting ----
  function validateRow(row) {
    // v10.2: name + condition + qty only. Set/Rarity/Code are optional.
    if (!row.name)                return "Please choose a card name (Manual or Scanned).";
    if (!row.condition)           return "Please choose a Condition.";
    if (!row.qty || row.qty < 1) return "Quantity must be at least 1.";
    return null;
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
      // Keep only the first placeholder option
      const ph = sel.options[0];
      while (sel.firstChild) sel.removeChild(sel.firstChild);
      if (ph) { sel.appendChild(ph); ph.selected = true; }
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
    resetSelect(conditionSel);

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
      const mergeTag = isMerged
        ? ` <span class="merge-tag">(merged × ${result.newQty})</span>`
        : "";
      openSuccessModal(
        `<div><strong>${row.name}</strong> (${row.set}${row.code ? " • " + row.code : ""})${mergeTag}</div>
         <div>Rarity: ${row.rarity} &bull; Condition: ${row.condition} &bull; Qty added: ${row.qty}</div>`
      );

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

  // ---- Primary Post to Sheet button ----
  confirmBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    if (inFlight) return;

    const previewCode = State?.selectedPrinting?.set_code || extractCodeFromOption(getSelectedText(setSel));
    if (codeModal) {
      openCodeConfirmModal(previewCode);
    } else {
      postCurrentSelection();
    }
  });

  if (confirmBtn) confirmBtn.disabled = true;

  // CONSOLE-OFF v13.4 console.log("[confirm] confirm.js initialized :: v13.4");
})();
