// js/lookup/api.js
(function () {
  'use strict';

  // Public namespaces used elsewhere in the app
  window.LookupParts = window.LookupParts || {};
  window.Lookup = window.Lookup || {};

  // ---------- tiny cache by query ----------
  const _cache = new Map();
  function getCached(q) { return _cache.get(q) || null; }
  function setCached(q, v) { _cache.set(q, v); }

  // ---------- normalization helpers (reusing normalize.js if present) ----------
  const N = window.LookupParts.normalize || window.Lookup.normalize || {};

  // normalize to lower-case string (fallback if no external normalizer)
  const norm = (s) =>
    (typeof N.norm === 'function')
      ? N.norm(s)
      : String(s || '').trim().toLowerCase();

  // similarity function (1 if equal ignoring case, else 0) unless provided
  const sim = (a, b) =>
    (typeof N.sim === 'function')
      ? N.sim(a, b)
      : (String(a).toLowerCase() === String(b).toLowerCase() ? 1 : 0);

  function hasMinLen3(s) { return (String(s || '').trim().length >= 3); }

  // Extra-hard sanitizer for fuzzy API (strip diacritics & odd chars)
  function sanitizeForApi(s) {
    let t = String(s || '');
    try { t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch {}
    t = t.replace(/[^A-Za-z0-9 \-]/g, ' ');
    t = t.replace(/\s+/g, ' ').trim();
    return t;
  }

  function toGoodBase(s) {
    const base = norm(s);
    const safe = sanitizeForApi(s);
    return (safe && safe.length) ? safe.toLowerCase() : base;
  }

  // ---------- fetchJson (patched) ----------
  // Treats 400/404 mid-typing as "no result" and safely parses JSON.
  async function fetchJson(url, { timeoutMs = 5000 } = {}) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);

    try {
      const res = await fetch(url, { signal: ctrl.signal });

      // Quiet the noisy 400/404s that happen during partial queries
      if (!res.ok) {
        if (res.status === 400 || res.status === 404) {
          try { await res.text(); } catch {}
          return null; // caller should treat as "no results"
        }
        throw new Error(`HTTP ${res.status}`);
      }

      // Defensive parse: empty/invalid body => null
      try {
        return await res.json();
      } catch {
        return null;
      }
    } finally {
      clearTimeout(to);
    }
  }

  // ---------- in-memory index for quick set/rarity lookups ----------
  // Index { nameLower -> { id, name, sets[] } }
  const _byName = new Map();
  function indexByName(list) {
    for (const c of (list || [])) {
      const key = String(c?.name || '').toLowerCase();
      if (!key) continue;
      const sets = Array.isArray(c?.sets) ? c.sets
                : Array.isArray(c?.card_sets) ? c.card_sets
                : [];
      _byName.set(key, { id: c?.id, name: c?.name, sets });
    }
  }

  function buildSetsAndRaritiesFromCard(card) {
    // Accept either { sets: [...] } or API shape { card_sets: [...] }
    const raw = Array.isArray(card?.sets) ? card.sets
              : Array.isArray(card?.card_sets) ? card.card_sets
              : [];
    const sets = [];
    const raritiesMap = {};
    for (const s of raw) {
      const sn = s?.set_name || '';
      const rr = s?.set_rarity || '';
      if (sn) sets.push({ set_name: sn, set_rarity: rr });
      if (sn && rr) {
        const arr = (raritiesMap[sn] = raritiesMap[sn] || []);
        if (!arr.includes(rr)) arr.push(rr);
      }
    }
    return { sets, raritiesMap };
  }

  // ---------- Core lookups ----------

  // Try exact `name=` first (manual/scanned string),
  // then fuzzy `fname=` with sanitized "good base".
  async function fetchCandidates(raw) {
    const exact = String(raw || '').trim();
    const fuzzy = toGoodBase(raw);

    if (!hasMinLen3(exact) && !hasMinLen3(fuzzy)) return [];

    // Cache by the exact-or-fuzzy input to keep UX snappy while typing
    const cached = getCached(exact || fuzzy);
    if (cached) return cached;

    const baseUrl = 'https://db.ygoprodeck.com/api/v7/cardinfo.php?';

    // 1) Exact name attempt (handles special chars)
    let out = [];
    if (hasMinLen3(exact)) {
      const urlExact = baseUrl + new URLSearchParams({ misc: 'yes', name: exact }).toString();
      const dataExact = await fetchJson(urlExact, { timeoutMs: 3000 });
      const listExact = Array.isArray(dataExact?.data) ? dataExact.data : [];
      if (listExact.length) {
        out = listExact.map(c => ({ id: c.id, name: c.name, sets: c.card_sets || [] }));
      }
    }

    // 2) Fuzzy fallback if exact returned nothing
    if (!out.length && hasMinLen3(fuzzy)) {
      const urlFuzzy = baseUrl + new URLSearchParams({ misc: 'yes', fname: fuzzy }).toString();
      const dataFuzzy = await fetchJson(urlFuzzy, { timeoutMs: 3000 });
      const listFuzzy = Array.isArray(dataFuzzy?.data) ? dataFuzzy.data : [];
      if (listFuzzy.length) {
        out = listFuzzy.map(c => ({ id: c.id, name: c.name, sets: c.card_sets || [] }));
      }
    }

    indexByName(out);
    setCached(exact || fuzzy, out);
    return out;
  }

  async function fetchCardSetsAndRarities(cardName) {
    const key = (cardName || '').toLowerCase();
    if (!key) return { sets: [], raritiesMap: {} };

    const hit = _byName.get(key);
    if (hit && Array.isArray(hit.sets) && hit.sets.length) {
      return buildSetsAndRaritiesFromCard(hit);
    }

    // Fallback: try strongest chunks against fname
    for (const q of strongestChunks(cardName)) {
      const url = 'https://db.ygoprodeck.com/api/v7/cardinfo.php?' +
                  new URLSearchParams({ misc: 'yes', fname: q }).toString();

      const data = await fetchJson(url, { timeoutMs: 3000 });
      const list = Array.isArray(data?.data) ? data.data : [];
      if (!list.length) continue;

      // Choose the best by similarity
      let best = null, bestScore = -Infinity;
      for (const c of list) {
        const score = sim(cardName, c?.name || '');
        if (score > bestScore) { best = c; bestScore = score; }
      }
      if (best) {
        return buildSetsAndRaritiesFromCard({
          id: best.id,
          name: best.name,
          sets: best.card_sets || []
        });
      }
    }

    return { sets: [], raritiesMap: {} };
  }

  // Break the string into “strong” chunks (long parts first)
  function strongestChunks(s) {
    const base = String(s || '').trim();
    if (!base) return [];
    const parts = base.split(/[^A-Za-z0-9]+/).filter(Boolean);
    parts.sort((a, b) => b.length - a.length);
    return parts.filter(p => p.length >= 3).slice(0, 4);
  }

  // Returns a canonical DB name (string) or "" if not confident.
  async function resolveNameFromScanNgrams(raw, { minScore = 0.65 } = {}) {
    const base = toGoodBase(raw);
    if (!base || base.length < 3) return '';

    const lists = [];
    try { lists.push(await fetchCandidates(raw)); } catch (_) {} // prefer raw first now
    for (const ch of strongestChunks(base)) {
      try { lists.push(await fetchCandidates(ch)); } catch (_) {}
    }

    let best = null, bestScore = -Infinity;
    for (const list of lists) {
      for (const c of (list || [])) {
        const score = sim(base, c?.name || '');
        if (score > bestScore) { best = c; bestScore = score; }
      }
    }
    return (bestScore >= minScore && best?.name) ? best.name : '';
  }

  // Public API
  const api = {
    fetchCandidates,
    fetchCardSetsAndRarities,
    bestNameMatch: resolveNameFromScanNgrams,
    resolveNameFromScanNgrams,
  };

  Object.assign(window.Lookup, api);
  window.LookupParts.api = api;
})();
