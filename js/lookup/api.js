// js/lookup/api.js
(function () {
  'use strict';

  window.LookupParts = window.LookupParts || {};
  window.Lookup = window.Lookup || {};

  // --- tiny cache by query ---
  const _cache = new Map();
  function getCached(q) { return _cache.get(q) || null; }
  function setCached(q, v) { _cache.set(q, v); }

  // --- normalization helpers (reusing normalize.js if present) ---
  const N = window.LookupParts.normalize || window.Lookup.normalize || {};
  const norm = (s) => (typeof N.norm === "function" ? N.norm(s) : String(s || "").trim().toLowerCase());
  const sim  = (a,b) => (typeof N.sim  === "function" ? N.sim(a,b) : (String(a).toLowerCase() === String(b).toLowerCase() ? 1 : 0));

  function hasMinLen3(s){ return (String(s||"").trim().length >= 3); }

  // Extra-hard sanitizer for API (strip diacritics & odd chars)
  function sanitizeForApi(s) {
    let t = String(s || "");
    // remove diacritics
    try { t = t.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); } catch {}
    // keep letters, digits, space and hyphen
    t = t.replace(/[^A-Za-z0-9 \-]/g, " ");
    t = t.replace(/\s+/g, " ").trim();
    return t;
  }

  function toGoodBase(s){
    const base = norm(s);
    // build API-friendly version from original string (not already lowered)
    const safe = sanitizeForApi(s);
    // fall back to normalized if sanitize nuked too much
    return (safe && safe.length) ? safe.toLowerCase() : base;
  }

  async function fetchJson(url, { timeoutMs = 5000 } = {}) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) {
        // Treat YGOPRODeck 400s as “no results” (they happen on edge queries)
        if (res.status === 400) {
          try { await res.text(); } catch {}
          return { data: [] };
        }
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.json();
    } finally { clearTimeout(to); }
  }

  // Build a small index by normalized name so we can get sets quickly later
  const _byName = new Map();
  function indexByName(cards) {
    for (const c of (cards || [])) {
      const key = norm(c?.name || "");
      if (!key) continue;
      _byName.set(key, c);
    }
  }

  function strongestChunks(name) {
    const t = sanitizeForApi(name).split(/\s+/).filter(Boolean); // use sanitized tokens
    // Prefer 2–3 word chunks if available, else singles
    const chunks = [];
    for (let k = Math.min(3, t.length); k >= 1; k--) {
      for (let i = 0; i + k <= t.length; i++) {
        chunks.push(t.slice(i, i + k).join(" "));
      }
      if (chunks.length) break;
    }
    return chunks.map(toGoodBase).filter(hasMinLen3);
  }

  function buildSetsAndRaritiesFromCard(card) {
    const sets = Array.isArray(card?.sets) ? card.sets : [];
    const raritiesMap = {};
    for (const p of sets) {
      const sn = p?.set_name || "";
      const r  = p?.set_rarity || "";
      if (!sn || !r) continue;
      if (!raritiesMap[sn]) raritiesMap[sn] = new Set();
      raritiesMap[sn].add(r);
    }
    Object.keys(raritiesMap).forEach(k => { raritiesMap[k] = Array.from(raritiesMap[k]); });
    return { sets, raritiesMap };
  }

  /** Return array: [{ id, name, sets:[{set_name,set_rarity,...}] }, ...] */
  async function fetchCandidates(raw) {
    const q = toGoodBase(raw);
    if (!q || !hasMinLen3(q)) return [];
    const url = "https://db.ygoprodeck.com/api/v7/cardinfo.php?misc=yes&fname=" + encodeURIComponent(q);
    console.log("[API Lookup] fetchCandidates →", url);

    const cached = getCached(q);
    if (cached) return cached;

    const data = await fetchJson(url, { timeoutMs: 3000 });
    const list = Array.isArray(data?.data) ? data.data : [];
    const out = list.map(c => ({ id: c.id, name: c.name, sets: c.card_sets || [] }));

    indexByName(out);
    setCached(q, out);
    return out;
  }

  /** Given a canonical card name, get its sets and a map of rarities per set */
  async function fetchCardSetsAndRarities(cardName) {
    const key = (cardName || "").toLowerCase();
    if (!key) return { sets: [], raritiesMap: {} };

    console.log("[API Lookup] fetchCardSetsAndRarities name:", cardName);

    const hit = _byName.get(key);
    if (hit && Array.isArray(hit.sets) && hit.sets.length) {
      return buildSetsAndRaritiesFromCard(hit);
    }

    // Fallback: try strongest chunks against fname
    for (const q of strongestChunks(cardName)) {
      const url = "https://db.ygoprodeck.com/api/v7/cardinfo.php?misc=yes&fname=" + encodeURIComponent(q);
      console.log("[API Lookup] fallback fname →", url);

      const data = await fetchJson(url, { timeoutMs: 3000 });
      const list = Array.isArray(data?.data) ? data.data : [];
      if (!list.length) continue;

      // Choose the best by similarity
      let best = null, bestScore = -Infinity;
      for (const c of list) {
        const score = sim(cardName, c?.name || "");
        if (score > bestScore) { bestScore = score; best = c; }
      }
      if (best && Array.isArray(best.card_sets) && best.card_sets.length) {
        const slim = { id: best.id, name: best.name, sets: best.card_sets };
        indexByName([slim]);
        return buildSetsAndRaritiesFromCard(slim);
      }
    }

    return { sets: [], raritiesMap: {} };
  }

  // ---- Name resolver used by UI (fallback for manual or noisy OCR) ----------
  // Returns a canonical DB name (string) or "" if not confident.
  async function resolveNameFromScanNgrams(raw, { minScore = 0.65 } = {}) {
    const base = toGoodBase(raw);
    if (!base || base.length < 3) return "";

    // Try full text first, then strongest chunks
    const lists = [];
    try { lists.push(await fetchCandidates(base)); } catch (_) {}
    for (const ch of strongestChunks(base)) {
      try { lists.push(await fetchCandidates(ch)); } catch (_) {}
    }

    let best = null, bestScore = -Infinity;
    for (const list of lists) {
      for (const c of (list || [])) {
        const n = c?.name || "";
        if (!n) continue;
        const s = sim(raw, n);               // 0..1 similarity
        if (s > bestScore) { bestScore = s; best = c; }
      }
    }

    return (best && bestScore >= minScore) ? (best.name || "") : "";
  }

  // Expose for both old/global callers and the namespaced UI
  window.resolveNameFromScanNgrams = resolveNameFromScanNgrams;

  function bestNameMatch(query, candidates) {
    if (typeof N.bestNameMatch === "function") return N.bestNameMatch(query, candidates);
    const q = (query || ""); if (!q) return 0;
    let best = 0, bestScore = -Infinity;
    for (let i = 0; i < (candidates || []).length; i++) {
      const nm = candidates[i]?.name || "";
      const s = sim(q, nm);
      if (s > bestScore) { bestScore = s; best = i; }
    }
    return best;
  }

  const api = {
    fetchCandidates,
    fetchCardSetsAndRarities,
    bestNameMatch,
    resolveNameFromScanNgrams,
  };

  Object.assign(window.Lookup, api);
  window.LookupParts.api = api;
})();
