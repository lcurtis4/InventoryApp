// js/lookup/codeSearch.js  — v8.3
// v8.3: added console logs around every DB request so each code search attempt
//       is visible (manual lookup, scanner per-pass lookup, parallel core lookup).
//
// Resolve a YGO set code (e.g. "MP25-EN120") to card name + printing info
// using the YGOPRODeck API.
//
// YGOPRODeck does NOT have a direct "lookup by set code" endpoint.
// Strategy:
//   1. Query  GET /cardinfo.php?num=<number>&set=<setPrefix>
//      → YGOPRODeck supports ?num= (card number within set) but requires full set name.
//      This is unreliable without knowing the exact set name.
//
//   2. Better: GET /cardinfo.php?cardset=<fullSetName>
//      → Returns all cards in a set. But we need the full set name, not just the prefix.
//
//   3. Practical approach used here:
//      a) GET /cardsets.php → cached list of all sets (small JSON, ~4KB gzipped).
//         Each entry: { set_name, set_code, num_of_cards, tcg_date }
//      b) Match set_code prefix (e.g. "MP25") against the code prefix.
//      c) GET /cardinfo.php?cardset=<matched_set_name>
//         Returns all cards in the set; find the one whose card_sets entry
//         matches the full code (e.g. "MP25-EN120").
//
//   Limitation: /cardsets.php returns TCG set metadata but set_code there
//   is a SHORT code like "MP25" that may not always match the card-level
//   set_code exactly (language editions complicate this). We fall back to
//   a name-based fuzzy search when the set list match fails.
//
// Cache policy: cardsets.json is cached for the session (one fetch, shared
// across all lookups). Card-set results are cached by full set name.
// Code→candidate results are cached by normalized code string.

(function () {
  "use strict";

  window.LookupParts = window.LookupParts || {};
  window.Lookup      = window.Lookup      || {};

  // ── Cache stores ────────────────────────────────────────────────────────────
  let   _setsListCache    = null;          // Promise<setEntry[]>  — one fetch
  const _setCardsCache    = new Map();     // setName → Promise<card[]>
  const _codeResultCache  = new Map();     // normalizedCode → Promise<candidate[]>

  // ── Helpers ─────────────────────────────────────────────────────────────────
  const BASE = "https://db.ygoprodeck.com/api/v7/";

  async function fetchJson(url, timeoutMs = 6000) {
    const ctrl = new AbortController();
    const t    = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) { try { await res.text(); } catch {} return null; }
      return await res.json();
    } catch (e) {
      // CONSOLE-OFF v12 if (e.name !== "AbortError") console.warn("[codeSearch] fetch error:", url, e.message);
      return null;
    } finally {
      clearTimeout(t);
    }
  }

  // Normalize a code for comparison / caching
  function normalizeCode(code) {
    return String(code || "").toUpperCase().trim();
  }

  // Extract the set prefix from a full code:  "MP25-EN120" → "MP25"
  function codePrefix(code) {
    const parts = normalizeCode(code).split("-");
    return parts[0] || "";
  }

  // Extract the numeric suffix: "MP25-EN120" → "EN120"
  function codeSuffix(code) {
    const parts = normalizeCode(code).split("-");
    return parts.slice(1).join("-") || "";
  }

  // Build a YGOPRODeck image URL from card id
  function cardImageUrl(id) {
    return id ? `https://images.ygoprodeck.com/images/cards_small/${id}.jpg` : null;
  }

  // ── Step 1: fetch the master set list (cached for session) ─────────────────
  function fetchSetsList() {
    if (_setsListCache) return _setsListCache;
    _setsListCache = fetchJson(BASE + "cardsets.php", 8000).then(data => {
      if (!Array.isArray(data)) { _setsListCache = null; return []; }
      return data; // [{ set_name, set_code, num_of_cards, tcg_date }, …]
    }).catch(() => { _setsListCache = null; return []; });
    return _setsListCache;
  }

  // ── Step 2: find set entries whose set_code matches the prefix ─────────────
  // Returns array of { set_name, set_code } sorted by date desc (newest first)
  async function findSetsForPrefix(prefix) {
    const sets = await fetchSetsList();
    const p    = prefix.toUpperCase();
    return sets.filter(s => {
      const sc = String(s.set_code || "").toUpperCase();
      return sc === p || sc.startsWith(p) || p.startsWith(sc);
    }).sort((a, b) => {
      // prefer newer sets (tcg_date descending)
      const da = a.tcg_date ? new Date(a.tcg_date).getTime() : 0;
      const db = b.tcg_date ? new Date(b.tcg_date).getTime() : 0;
      return db - da;
    });
  }

  // ── Step 3: fetch all cards in a set (cached by set name) ─────────────────
  function fetchCardsInSet(setName) {
    if (_setCardsCache.has(setName)) return _setCardsCache.get(setName);
    const p = fetchJson(
      BASE + "cardinfo.php?" + new URLSearchParams({ cardset: setName, misc: "yes" }).toString(),
      10000
    ).then(d => Array.isArray(d?.data) ? d.data : [])
     .catch(() => []);
    _setCardsCache.set(setName, p);
    return p;
  }

  // ── Step 4: find candidate printings that exactly match the full code ──────
  // Returns array of candidate objects:
  // { name, id, imageUrl, set_name, set_rarity, set_code, exactMatch: bool }
  async function candidatesForCode(code) {
    const normCode = normalizeCode(code);
    if (!normCode || !normCode.includes("-")) return [];

    if (_codeResultCache.has(normCode)) return _codeResultCache.get(normCode);

    const promise = _resolveCode(normCode);
    _codeResultCache.set(normCode, promise);
    return promise;
  }

  async function _resolveCode(normCode) {
    const prefix = codePrefix(normCode);
    const suffix = codeSuffix(normCode); // e.g. "EN120"

    const candidates = [];

    // --- Path A: set-list → cardset lookup ---
    let foundViaSetList = false;
    try {
      const matchedSets = await findSetsForPrefix(prefix);
      for (const setEntry of matchedSets.slice(0, 3)) { // try up to 3 set matches
        const cards = await fetchCardsInSet(setEntry.set_name);
        for (const card of cards) {
          const prints = Array.isArray(card.card_sets) ? card.card_sets : [];
          for (const pr of prints) {
            const prCode = normalizeCode(pr.set_code || "");
            // Exact match on the full code
            if (prCode === normCode) {
              candidates.push({
                name:       card.name,
                id:         card.id,
                imageUrl:   cardImageUrl(card.id),
                set_name:   pr.set_name || setEntry.set_name,
                set_rarity: pr.set_rarity || "",
                set_code:   prCode,
                exactMatch: true,
                source:     "set-list",
              });
              foundViaSetList = true;
            }
          }
        }
        if (foundViaSetList) break; // stop after first set that yielded an exact hit
      }
    } catch (e) {
      // CONSOLE-OFF v12 console.warn("[codeSearch] set-list path failed:", e);
    }

    // --- Path B: if no exact match, try fname search on prefix as a query ---
    // This handles codes where set_code in the set list doesn't align perfectly.
    if (!foundViaSetList) {
      try {
        const url = BASE + "cardinfo.php?" +
          new URLSearchParams({ misc: "yes", fname: prefix }).toString();
        const data = await fetchJson(url, 6000);
        const list = Array.isArray(data?.data) ? data.data : [];
        for (const card of list) {
          const prints = Array.isArray(card.card_sets) ? card.card_sets : [];
          for (const pr of prints) {
            const prCode = normalizeCode(pr.set_code || "");
            if (prCode === normCode) {
              candidates.push({
                name:       card.name,
                id:         card.id,
                imageUrl:   cardImageUrl(card.id),
                set_name:   pr.set_name || "",
                set_rarity: pr.set_rarity || "",
                set_code:   prCode,
                exactMatch: true,
                source:     "fname-fallback",
              });
            }
          }
        }
      } catch (e) {
        // CONSOLE-OFF v12 console.warn("[codeSearch] fname fallback failed:", e);
      }
    }

    // De-duplicate by card id + rarity (same card can appear multiple times)
    const seen = new Set();
    return candidates.filter(c => {
      const key = `${c.id}|${c.set_rarity}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // ── Public helper: resolve code → {name, printing, candidates} ────────────
  // Returns:
  //   { status: "found"|"multi"|"none",
  //     code,
  //     candidates: [...],   // array of candidate objects (may be empty)
  //     bestCandidate: obj|null }
  async function resolveCode(rawCode) {
    const code = normalizeCode(rawCode);
    if (!code) {
      // CONSOLE-OFF v12 console.log("[codeSearch] resolveCode skipped — empty input");
      return { status: "none", code, candidates: [], bestCandidate: null };
    }

    // CONSOLE-OFF v12 console.log("[codeSearch] resolveCode attempt:", code);
    let cands;
    try {
      cands = await candidatesForCode(code);
    } catch (e) {
      console.error("[codeSearch] resolveCode error:", e);
      cands = [];
    }

    if (!cands.length) {
      // CONSOLE-OFF v12 console.log("[codeSearch] resolveCode → NO MATCH for", code);
      return { status: "none", code, candidates: [], bestCandidate: null };
    }

    const best = cands[0];
    const status = cands.length === 1 ? "found" : "multi";
    // CONSOLE-OFF v12 console.log(
      // CONSOLE-OFF v12 "[codeSearch] resolveCode → %s for %s (%d candidate%s) — best: %s",
      // CONSOLE-OFF v12 status, code, cands.length, cands.length === 1 ? "" : "s", best?.name || "?"
    // CONSOLE-OFF v12 );
    return { status, code, candidates: cands, bestCandidate: best };
  }

  // ── Exports ─────────────────────────────────────────────────────────────────
  const codeSearch = {
    resolveCode,
    candidatesForCode,
    fetchSetsList,        // expose so UI can pre-warm the cache on startup
    normalizeCode,
    codePrefix,
  };

  window.LookupParts.codeSearch = codeSearch;
  window.Lookup.resolveCode     = resolveCode;
  window.Lookup.codeSearch      = codeSearch;
})();
