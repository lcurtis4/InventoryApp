// js/ui/autocomplete.js — global attach function for Manual Name dropdown
(function(){
  function attach(inputEl, onCommit) {
    // gating + debounce settings
    const MIN_LEN = 4;                  // wait for 4+ chars before hitting API
    const DEBOUNCE_MS = 350;            // a touch slower = fewer mid-typing calls

    // local state
    let _lastQuery = "";
    const _noResultCache = new Set();   // remembers queries that returned no suggestions
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
      fontFamily: "system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif",
      fontSize: "14px",
      display: "none"
    });
    document.body.appendChild(box);

    let items = [];
    let highlight = -1;

    function positionBox() {
      const r = inputEl.getBoundingClientRect();
      box.style.left = `${Math.round(window.scrollX + r.left)}px`;
      box.style.top  = `${Math.round(window.scrollY + r.bottom + 4)}px`;
      box.style.width = `${Math.round(r.width)}px`;
    }

    function openBox(){ positionBox(); box.style.display = "block"; }
    function closeBox(){ box.style.display = "none"; box.innerHTML = ""; items = []; highlight = -1; }

    function setHighlight(i) {
      highlight = i;
      Array.from(box.children).forEach((el, idx) => {
        el.style.background = (idx === i) ? "#efefef" : "#fff";
      });
    }

    function commitSelection(i) {
      if (i < 0 || i >= items.length) return;
      const val = items[i];
      inputEl.value = val;
      closeBox();
      if (typeof onCommit === "function") onCommit(val);
    }

    function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c])); }

    // Debounced suggestions updater (delay adjusted to 300ms)
      const updateSuggestions = debounce(async () => {
      const q = (inputEl.value || "").trim();

      // ---- gates to avoid "bad" requests that cause 400s ----
      if (q.length < MIN_LEN) { closeBox(); return; }            // too short
      if (!/^[A-Za-z0-9][A-Za-z0-9 '\-:]*[A-Za-z0-9]$/.test(q)) { // sanity check
        closeBox(); return;
      }
      if (q === _lastQuery) return;                              // same as last time
      if (_noResultCache.has(q)) { closeBox(); return; }         // known-no-result

      _lastQuery = q;

      try {
        const cand = await Lookup.fetchCandidates(q);            // may return []/null
        if (!Array.isArray(cand) || !cand.length) {
          _noResultCache.add(q);                                 // remember "bad" query
          closeBox();
          return;
        }

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
      } catch (e) {
        // Do NOT treat mid-typing misses as errors in the console
        console.debug("[autocomplete] skipped:", e);
        closeBox();
      }
    }, DEBOUNCE_MS);


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

    document.addEventListener("mousedown", (e) => {
      if (e.target === inputEl) return;
      if (!box.contains(e.target)) closeBox();
    });
  }

  // simple debounce helper (already present in your codebase, keep existing if you have one)
  function debounce(fn, ms) {
    let t = null;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn.apply(null, args), ms); };
  }

  window.Autocomplete = { attach };
})();
