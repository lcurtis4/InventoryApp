// js/ui/modal.js
(function(){
  window.UI = window.UI || {};
  const $ = (id) => document.getElementById(id);

  function resumeScanningFromModalClose() {
    try { window.Scanner.resume(); } catch (_) {}
    // Flip the Pause/Resume toggle back to "Pause Scanning"
    if (window.UI && typeof window.UI.showResume === "function") {
      window.UI.showResume(false);
    }
    const auto = $("autoStatus");
    if (auto) auto.textContent = "Resumed scanning for the next card.";
  }

  const modal = {
    open(html){
      const m = $("successModal");
      const dialog = m?.querySelector(".modal__dialog");
      const body = $("successModalBody");
      if (!m || !dialog || !body) return;
      body.innerHTML = html || "";
      m.classList.add("is-open");
      m.setAttribute("aria-hidden", "false");
      dialog.setAttribute("tabindex", "-1");
      dialog.focus();
      document.documentElement.style.overflow = "hidden";
    },
    close(){
      const m = $("successModal");
      if (!m) return;
      // UI-7: aria-hidden focus violation fix — if focus is inside the modal
      // we are about to hide, blur it BEFORE setting aria-hidden="true".
      // Otherwise Chrome logs: "Blocked aria-hidden on an element because
      // its descendant retained focus." Move focus to <body> as a neutral
      // fallback so keyboard users don't lose their place entirely.
      if (m.contains(document.activeElement)) {
        try { document.activeElement.blur(); } catch (_) {}
        try { document.body.focus(); } catch (_) {}
      }
      m.classList.remove("is-open");
      m.setAttribute("aria-hidden", "true");
      document.documentElement.style.overflow = "";
      // resume scanning upon closing the success dialog
      resumeScanningFromModalClose();
    },
    init(){
      const m = $("successModal");
      if (!m) return;

      // Close button (×)
      m.querySelector(".modal__close")?.addEventListener("click", modal.close);

      // OK button
      m.querySelector(".modal__ok")?.addEventListener("click", modal.close);

      // Click backdrop to close
      m.querySelector(".modal__backdrop")?.addEventListener("click", (e) => {
        // Only if backdrop itself, not inner dialog
        if (e.target === e.currentTarget) modal.close();
      });

      // Esc to close
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && m.classList.contains("is-open")) modal.close();
      });
    }
  };

  window.UI.modal = modal;
})();
