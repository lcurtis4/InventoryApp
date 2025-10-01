/* js/ui/confirm.js (passthrough version)
 * - Click "Post to Sheet" => open confirm modal with code from UI.
 * - Confirm => re-click the same button and let the ORIGINAL handler run.
 * - Cancel/Close/ESC/Backdrop => close modal + reset form.
 */

(function () {
  // Ensure DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  function init() {
    const $ = (sel, root = document) => root.querySelector(sel);

    // Elements
    const modal      = $('#codeConfirmModal');
    const modalText  = $('#codeConfirmText');
    const btnConfirm = $('#codeConfirmConfirmBtn');
    const btnCancel  = $('#codeConfirmCancelBtn');
    const btnCloseX  = $('#codeConfirmCloseX');
    const backdrop   = modal ? modal.querySelector('.modal-backdrop') : null;

    // Primary target: #confirmBtn (your Post to Sheet button)
    let postBtn = $('#confirmBtn');
    if (!postBtn) {
      console.warn('[confirm.js] Post button #confirmBtn not found.');
      return;
    }
    // Make sure it doesn't submit a <form> prematurely

    if (!modal) {
      console.warn('[confirm.js] #codeConfirmModal not found; confirmation gate disabled.');
      return;
    }

    // Show/Hide helpers (force display so CSS can't block it)
    function showModal() {
      modal.classList.remove('hidden');
      modal.setAttribute('aria-hidden', 'false');
      modal.style.display = 'block';
    }
    function hideModal() {
      modal.classList.add('hidden');
      modal.setAttribute('aria-hidden', 'true');
      modal.style.display = 'none';
    }

    // Read code from existing UI (no data building)
    function readCodeForDisplay() {
      // Prefer the UI badge if you render it
      const badge = document.querySelector('[data-code-badge]');
      if (badge && badge.textContent.trim()) return badge.textContent.trim();

      // Try printing select's selected option data attribute/text
      const printingSel = $('#printingSelect');
      const opt = printingSel ? printingSel.options[printingSel.selectedIndex] : null;
      if (opt) {
        const dataCode = opt.getAttribute('data-code') || opt.dataset?.code;
        if (dataCode && dataCode.trim()) return dataCode.trim();
        const txt = (opt.textContent || '').trim();
        if (txt) return txt;
      }

      return '(none)';
    }

    // Reset form to pristine (IDs match the HTML I gave you)
    function resetForm() {
      const manualName = $('#manualName');
      const qty        = $('#qtyInput') || $('#qty');
      const setSel     = $('#setSelect');
      const printSel   = $('#printingSelect');
      const notes      = $('#notes');
      const codeBadge  = document.querySelector('[data-code-badge]');
      const preview    = $('#preview');
      const errorsBox  = $('#errors');
      const results    = $('#resultsTable');

      if (manualName) manualName.value = '';
      if (qty)        qty.value = '1';
      if (setSel)     setSel.selectedIndex = 0;
      if (printSel)   printSel.selectedIndex = 0;
      if (notes)      notes.value = '';
      if (errorsBox)  errorsBox.textContent = '';
      if (codeBadge)  codeBadge.textContent = '';
      if (preview && preview.tagName === 'IMG') preview.src = '';
      if (results) results.innerHTML = '';

      if (typeof window?.UI?.recomputeGates === 'function') {
        try { window.UI.recomputeGates(); } catch (_) {}
      }
    }

    // Flag to allow the original handler to run on the forwarded click
    let allowDirectPost = false;

    // Intercept the first click to show modal
    postBtn.addEventListener('click', (ev) => {
      if (allowDirectPost) {
        // Consume the flag and let other handlers proceed normally
        allowDirectPost = false;
        return; // Do NOT preventDefault; pass-through to original handler(s)
      }

      // Otherwise, this is the user's initial click => show confirm
      ev.preventDefault();

      const codeText = readCodeForDisplay();
      if (modalText) modalText.textContent = `Confirm Card Code: ${codeText}`;
      showModal();
    });

    // Confirm => forward the click to the original handler
    if (btnConfirm) {
          function invokeOriginalPost() {
      // Try explicit app hooks first (adjust if you know the exact name):
      if (window?.UI?.confirmNow)            return window.UI.confirmNow();
      if (window?.UI?.onConfirm)             return window.UI.onConfirm();
      if (window?.UI?.postSelection)         return window.UI.postSelection();
      if (window?.Sheet?.postCurrent)        return window.Sheet.postCurrent();
      if (window?.Sheet?.submitCurrent)      return window.Sheet.submitCurrent();

      // Broadcast for any listener that used to bind the click/submit:
      document.dispatchEvent(new CustomEvent('confirm:proceed'));

      // Fallback: simulate the original click so form submit handlers fire.
      // (Because we REMOVED the type=button override, a submit handler will run.)
      postBtn.click();
    }

    if (btnConfirm) {
      btnConfirm.addEventListener('click', () => {
        hideModal();
        invokeOriginalPost();
      });
    }

    }

    // Cancel/Close/Backdrop/ESC => close + reset
    function cancelAndReset() {
      hideModal();
      resetForm();
    }
    if (btnCancel) btnCancel.addEventListener('click', cancelAndReset);
    if (btnCloseX) btnCloseX.addEventListener('click', cancelAndReset);
    if (backdrop)  backdrop.addEventListener('click', cancelAndReset);
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && modal.getAttribute('aria-hidden') === 'false') {
        cancelAndReset();
      }
    });

    console.log('[confirm.js] Confirmation gate ready.');
  }
})();
