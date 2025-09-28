// js/ui/autocomplete.js — global attach function for Manual Name dropdown
(function(){
  function attach(inputEl, onCommit) {
    if (!inputEl) return;

    const box = document.createElement("div");
    box.id = "nameSuggestBox";
    Object.assign(box.style, {
      position: "absolute",
      zIndex: 10000,
      minWidth: "240px",
      maxWidth: "480px",
      maxHeight: "280px",
      overflowY: "auto",
      background: "#fff",
      border: "1px solid rgba(0,0,0,.15)",
      borderRadius: "8px",
      boxShadow: "0 8px 24px rgba(0,0,0,.12)",
      fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif",
      fontSize: "14px",
      padding: "4px 0",
      display: "none"
    });
    document.body.appendChild(box);

    function positionBox() {
      const r = inputEl.getBoundingClientRect();
      box.style.left = (window.scrollX + r.left) + "px";
      box.style.top  = (window.scrollY + r.bottom + 4) + "px";
      box.style.width = r.width + "px";
    }

    let t = null;
    const debounce = (fn, ms) => function (...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), ms); };

    let items = [], highlight = -1;
    function clearBox() { box.innerHTML = ""; items = []; highlight = -1; box.style.display = "none"; }
    function openBox() { if (items.length) { positionBox(); box.style.display = "block"; } }
    function closeBox() { clearBox(); }
    function setHighlight(i) {
      const children = Array.from(box.children);
      highlight = Math.max(0, Math.min(i, children.length - 1));
      children.forEach((el, idx) => { el.style.background = idx === highlight ? "#f2f6ff" : "transparent"; });
    }
    function commitSelection(i) {
      if (i < 0 || i >= items.length) return;
      const name = items[i];
      inputEl.value = name;
      closeBox();
      if (typeof onCommit === "function") onCommit(name);
    }

    function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c])); }

    const updateSuggestions = debounce(async () => {
      const q = (inputEl.value || "").trim(); if (!q) { closeBox(); return; }
      try {
        const cand = await Lookup.fetchCandidates(q);
        if (!Array.isArray(cand) || !cand.length) { closeBox(); return; }
        const ql = q.toLowerCase(); const set = new Set(); const list = [];
        for (const c of cand) {
          const n = c && c.name ? String(c.name) : ""; if (!n) continue;
          if (n.toLowerCase().includes(ql) && !set.has(n)) { set.add(n); list.push(n); if (list.length >= 50) break; }
        }
        if (!list.length) { closeBox(); return; }
        items = list; box.innerHTML = "";
        list.forEach((name, idx) => {
          const el = document.createElement("div");
          el.setAttribute("role", "option");
          Object.assign(el.style, { padding: "8px 12px", cursor: "pointer", whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" });
          el.dataset.index = String(idx);
          const low = name.toLowerCase(); const pos = low.indexOf(ql);
          if (pos >= 0) {
            const pre = name.slice(0, pos), mid = name.slice(pos, pos + ql.length), post = name.slice(pos + ql.length);
            el.innerHTML = `${escapeHtml(pre)}<mark style='background:#ffef8a'>${escapeHtml(mid)}</mark>${escapeHtml(post)}`;
          } else {
            el.textContent = name;
          }
          el.addEventListener("mouseenter", () => { setHighlight(idx); });
          el.addEventListener("mousedown", (e) => { e.preventDefault(); commitSelection(idx); });
          box.appendChild(el);
        });
        openBox(); setHighlight(0);
      } catch (e) { console.error("name suggestions failed:", e); closeBox(); }
    }, 120);

    inputEl.addEventListener("input", updateSuggestions);
    inputEl.addEventListener("focus", () => { if ((inputEl.value || "").trim()) updateSuggestions(); positionBox(); });
    window.addEventListener("resize", positionBox);
    window.addEventListener("scroll", positionBox, true);

    inputEl.addEventListener("keydown", (e) => {
      if (box.style.display === "none") return;
      const max = items.length - 1;
      if (e.key === "ArrowDown") { e.preventDefault(); setHighlight(Math.min(highlight + 1, max)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight(Math.max(highlight - 1, 0)); }
      else if (e.key === "Enter" || e.key === "Tab") { if (highlight >= 0) { e.preventDefault(); commitSelection(highlight); } }
      else if (e.key === "Escape") { closeBox(); }
    });
    document.addEventListener("mousedown", (e) => { if (e.target === inputEl) return; if (!box.contains(e.target)) closeBox(); });
  }

  window.Autocomplete = { attach };
})();
