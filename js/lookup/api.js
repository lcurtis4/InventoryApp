// js/lookup/api.js  — v10.6
// v10.6: fetchCandidates local-enrichment now queries CardDb (IndexedDB
//        snapshot) BEFORE falling back to YGOPRODeck API. Previously a local
//        NamesStore hit immediately fired ?name= to YGOPRODeck for set data,
//        defeating the whole point of the local DB. Now:
//          1. NamesStore.findBest() → local name match (unchanged)
//          2. CardDb.lookupByName() → local sets/rarities (NEW — no network)
//          3. Only falls through to YGOPRODeck if CardDb misses (new/missing card)
//        fetchCardSetsAndRarities already had this priority; now fetchCandidates
//        (the scan-path entry point) does too.
// v10.5: fillSetsForCandidate() now RACES all 6 fallback paths in parallel
//        instead of running them sequentially. v10.4 worked but was slow on
//        broken-record cards: cardinfo.php?name= would 500 three times in a
//        row (~3.5s each with backoff), then ?fname= would also 500, then
//        corsproxy×2 would also fail, and ONLY THEN would the working
//        cardset-scan fire — total ~7-13s. The new design kicks off every
//        path at t=0 and a custom _firstNonEmpty() combinator resolves with
//        the first path that returns a card with a non-empty card_sets[].
//        Failing paths just settle to null and don't block the winner.
//        Best case: ~300ms (when ?name= works it wins instantly).
//        Worst case: ~3-5s (cardset-scan completes after the others 500).
//        Also dropped the 3-attempt ?name= retry-with-backoff loop — for
//        these broken cards the 500s are NOT transient, retrying just wastes
//        time. Single attempt per path, racing.
// v10.4: fillSetsForCandidate() gains a 6th step that uses the WORKING
//        cardsets.php + ?cardset= path (the same one codeSearch.resolveCode
//        uses for manual code lookups). When YGOPRODeck's cardinfo.php is
//        500'ing for both ?name= and ?fname= variants — including via the
//        corsproxy — the cardsets/cardset endpoints are still healthy. We
//        iterate the most-recent N TCG sets in parallel, fetch their cards
//        via ?cardset=<setName>, and look for the row whose card.name matches
//        our confirmed name. As soon as we find ONE set that contains the
//        card, that response includes the card's full card_sets list — every
//        printing across every set. That gives us a real Set/Rarity dropdown
//        without ever needing cardinfo.php?name= to work.
// v10.3: fillSetsForCandidate() gains a 5th step — corsproxy ?fname= retry.
//        ?fname= takes a different upstream code path and is often healthy
//        when ?name= is broken. Trying it through corsproxy as a final
//        fallback rescues some cases.
// v10.1: fillSetsForCandidate() gains a CORS-proxy 4th step. When direct
// db.ygoprodeck.com responses come back malformed or blocked on the user's
// network (some ISP / edge cache combos return 200-but-empty or hang), the
// proxy variant goes through corsproxy.io which has different upstream peering.
// Also: each step now logs a one-line summary at the END of the run so a single
// console line tells you which path won.
// v9.3: fillSetsForCandidate() is now resilient to YGOPRODeck flakes.
//       Strategy (each step short-circuits on first non-empty sets[]):
//         1. exact ?name= with up to 3 attempts and 400/800ms backoff
//         2. ?id=<id> if the candidate has an id (different upstream code path,
//            often healthy when ?name= is 500-ing)
//         3. ?fname=<longest-chunk> as a last fuzzy fallback
//       Each step logs explicitly so debugging is straightforward.
//
// v9.2: Issue — Set/Rarity dropdowns empty even when Name resolves & Find Printings
//       reports "Found 1 match(es)".
//       Root cause: v9.1's LOCAL-ONLY fallback returns a synthetic candidate with
//       sets:[] and that empty-sets result gets cached under the OCR query key.
//       Subsequent Find-Printings clicks reuse the cached synthetic, so dropdowns
//       stay empty even when YGOPRODeck is healthy.
//       Fixes in this file:
//         1. Synthetic-only results are flagged with __synthetic:true and are NOT
//            cached — every call re-attempts enrichment until sets are populated.
//         2. fetchCardSetsAndRarities() now also tries an exact `?name=` lookup
//            (in addition to the strongest-chunk fname path) so the safety-net
//            from lookup.js can always reach the upstream sets list.
//         3. New helper: fillSetsForCandidate(candidate) — given a candidate with
//            empty sets, fetches & mutates its .sets in place. Returns true on
//            success. Used by lookup.js as the final safety net.
//
// v9.1: Two upstream-driven fixes (still part of Issue #1 — name OCR cleanup):
//   1. Local hit no longer requires a successful API enrich — if the
//      follow-up cardinfo.php call fails (500/timeout), we return a
//      synthetic candidate with just { name }. The UI gets the resolved
//      name; sets/rarities can fill in later.
//   2. Drop `misc=yes` from EVERY cardinfo.php call. YGOPRODeck is
//      currently 500-ing on `misc=yes + name=` and `misc=yes + multi-word
//      fname=` with "Database query parameter mismatch". card_sets and
//      card_prices are in the default response anyway.
//   3. fetchJson() now treats 5xx as "no result" instead of throwing,
//      so transient upstream flakes don't kill the scan tick.
//
// v9.0: Stronger OCR-noise sanitizer + local-first short-circuit.
//       Before any network call, fetchCandidates() asks NamesStore.findBest()
//       for a high-confidence local match. On hit, it resolves the full card
//       via ?name= (single round-trip for set/rarity data) and returns.
//       The sanitizer now also strips single trailing letters and standalone
//       symbol/letter tail tokens like "Solemn Accusation E" / "Solemn Accusation &".
//
// v8.3b: fetchCandidates() now strips trailing OCR noise (lone digits, single
//         letters, short non-word tail tokens) and retries the query when the
//         strict version returns zero results. This rescues common OCR cases
//         like "Clown Crew Meteor 68" → "Clown Crew Meteor".
//         Adds detailed console logs for every API attempt.
(function () {
  'use strict';

  // Public namespaces used elsewhere in the app
  window.LookupParts = window.LookupParts || {};
  window.Lookup = window.Lookup || {};
  // CONSOLE-OFF v12 console.log("[api] module loaded — v10.5 (fillSets: parallel race of 6 paths)");

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

  // v11 (#27 console hygiene): YGOPRODeck's cardinfo.php returns 400 Bad Request
  // for a few predictable query shapes, and even though fetchJson() swallows the
  // parsed body, the browser still logs the failed GET to the console/network
  // tab. We saw ≥5 such 400s during a single name lookup (per-keystroke
  // autocomplete + chunk fan-out hitting empty/short/garbage queries). These
  // guards short-circuit BEFORE the request is made so no 400 is ever emitted:
  //   • fname must be non-empty and ≥3 chars (upstream 400s on shorter)
  //   • fname must NOT contain spaces — multi-word fname reliably 400s upstream
  //     (documented in v9.1 notes); callers should chunk to single words first
  //   • name must be non-empty and ≥3 chars
  function isFnameQueryable(s) {
    const t = String(s || '').trim();
    if (t.length < 3) return false;
    if (/\s/.test(t)) return false; // multi-word fname → guaranteed 400 upstream
    return true;
  }
  // v12 (#67): a raw OCR title is only worth sending to cardinfo.php?name= if it
  // actually looks like a card name. A garbage fallback like "DY THE MAGIC ELF &l"
  // used to be sent verbatim — the trailing "&l" injected a stray query param and
  // the malformed/non-name string returned 400 Bad Request, logging a console
  // error on every bad scan. Guard BEFORE the request so no 400 is ever emitted.
  //   • must be ≥3 chars after trimming
  //   • must contain at least 2 letters (reject pure-symbol / mostly-junk strings)
  //   • must not be majority non-alphanumeric (reject "&&-l |" style residue)
  function isNameQueryable(s) {
    const t = String(s || '').trim();
    if (t.length < 3) return false;
    const letters = (t.match(/[A-Za-z]/g) || []).length;
    if (letters < 2) return false;
    const alnum = (t.match(/[A-Za-z0-9]/g) || []).length;
    // Reject strings that are mostly punctuation/symbols (OCR icon residue).
    if (alnum / t.length < 0.5) return false;
    return true;
  }

  // v12 (#67): produce a safe ?name= query from a raw OCR title. We strip the
  // characters that corrupt the request (notably '&', which injects a query
  // param) and trailing OCR noise, but keep enough of the name for an exact
  // match. Returns '' when nothing name-like survives (caller must skip).
  function nameQueryFromRaw(raw) {
    // Remove '&' and other URL-significant junk, collapse whitespace.
    let t = String(raw || '').replace(/[&?#=]/g, ' ').replace(/\s+/g, ' ').trim();
    // Drop trailing OCR icon/level residue ("&l", "68", "-e", etc.).
    t = stripTrailingOcrNoise(t);
    return isNameQueryable(t) ? t : '';
  }

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

  // v9.0: aggressive OCR noise strip.
  // The card-image OCR commonly tacks junk onto the end of the title:
  //   level pips → digit runs ("68", "3", "2")
  //   attribute / trap / spell icon → single letter or symbol ("&", "E", "R", "-e", "Ee")
  //   stray punctuation → ".", "-", "|", "&"
  // v9 rules (only the END of the string is touched — real names can start with
  // single letters/digits):
  //   • Drop any trailing token that is all-digits, regardless of length.
  //   • Drop any trailing token that is <= 2 chars (letters/symbols/mixed).
  //   • Drop trailing 3-char tokens that contain ZERO letters (e.g. "-e-", "&&&").
  //   • If the LAST surviving token is a single letter glued onto a 4+ char
  //     previous token ("Accusatione" pattern won't trigger; "Accusation e" will),
  //     it's already been removed by rule 2.
  //   • Stop as soon as a "real" token survives (>=3 chars AND contains a letter).
  // Also strip leading/trailing non-alpha runs at the very end.
  function stripTrailingOcrNoise(s) {
    let t = String(s || '').trim();
    if (!t) return t;

    // Collapse '&' to space first — it's almost always icon noise mid-string
    t = t.replace(/&/g, ' ').replace(/\s+/g, ' ').trim();

    let parts = t.split(/\s+/);
    while (parts.length > 1) {
      const last = parts[parts.length - 1];
      const lower = last.toLowerCase();
      const isAllDigits = /^\d+$/.test(last);
      const isShort     = last.length <= 2;                          // single letter/symbol/2-char junk
      const noLetters   = !/[A-Za-z]/.test(last);                    // pure punctuation
      const tinyNoAlpha = last.length <= 3 && noLetters;             // "-e-", "&&&"
      // Common OCR icon residue glued as its own token
      const knownJunk   = /^(ee|-e|e-|ce|re|er|br|tr|tp|ft|fi|fl)$/.test(lower);

      if (isAllDigits || isShort || tinyNoAlpha || knownJunk) {
        parts.pop();
        continue;
      }
      break;
    }
    let out = parts.join(' ').trim();
    // Strip leading/trailing non-alpha runs
    out = out.replace(/^[^A-Za-z]+/, '').replace(/[^A-Za-z\)]+$/, '').trim();
    return out;
  }

  // ---------- fetchJson (patched) ----------
  // Treats 400/404 mid-typing as "no result" and safely parses JSON.
  async function fetchJson(url, { timeoutMs = 5000 } = {}) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);

    try {
      const res = await fetch(url, { signal: ctrl.signal });

      // Quiet the noisy 400/404s that happen during partial queries
      // v9.0: also treat 5xx as "no result" instead of throwing. YGOPRODeck
      // occasionally 500s for valid queries (esp. with misc=yes on long
      // names containing non-ASCII chars). Bubbling those up kills the
      // scan tick; returning null lets callers fall through cleanly.
      if (!res.ok) {
        if (res.status === 400 || res.status === 404 || res.status >= 500) {
          try { await res.text(); } catch {}
          // CONSOLE-OFF v12 if (res.status >= 500) console.warn('[api] upstream', res.status, 'for', url);
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

  // ---------- Price helpers ----------
  function extractTcgplayerPrice(card) {
    // YGOPRODeck shape: card.card_prices[0].tcgplayer_price is a string number
    const p = card?.card_prices && card.card_prices[0] && card.card_prices[0].tcgplayer_price;
    const n = (p === undefined || p === null || p === '') ? NaN : Number(p);
    return Number.isFinite(n) ? n : '';
  }

  async function fetchCardPrice(name) {
    const cardName = String(name || '').trim();
    if (!hasMinLen3(cardName)) return '';

    const baseUrl = 'https://db.ygoprodeck.com/api/v7/cardinfo.php?';
    // v9.1: misc=yes currently breaks upstream; the default response
    // already includes card_prices, so we can drop it safely.
    const urlExact = baseUrl + new URLSearchParams({ name: cardName }).toString();
    let data = await fetchJson(urlExact, { timeoutMs: 3000 });
    let list = Array.isArray(data?.data) ? data.data : [];

    // Fuzzy fallback
    if (!list.length) {
      const urlFuzzy = baseUrl + new URLSearchParams({ fname: toGoodBase(cardName) }).toString();
      data = await fetchJson(urlFuzzy, { timeoutMs: 3000 });
      list = Array.isArray(data?.data) ? data.data : [];
      if (list.length > 1) {
        // pick best by simple case-insensitive match score
        list.sort((a, b) => sim(cardName, b?.name || '') - sim(cardName, a?.name || ''));
      }
    }

    const card = list[0];
    return extractTcgplayerPrice(card);
  }

  // ---------- Core lookups ----------

  // Try exact `name=` first (manual/scanned string),
  // then fuzzy `fname=` with sanitized "good base".
  async function fetchCandidates(raw) {
    const exact   = String(raw || '').trim();
    const fuzzy   = toGoodBase(raw);
    // v8.3b: third attempt uses a stripped query if exact + fuzzy both miss.
    const stripped = stripTrailingOcrNoise(fuzzy);

    if (!hasMinLen3(exact) && !hasMinLen3(fuzzy)) {
      // CONSOLE-OFF v12 console.log("[api] fetchCandidates: input too short, skipping", { raw, exact, fuzzy });
      return [];
    }

    // Cache by the exact-or-fuzzy input to keep UX snappy while typing
    const cached = getCached(exact || fuzzy);
    if (cached) {
      // CONSOLE-OFF v12 console.log("[api] fetchCandidates: cache hit for", exact || fuzzy, "→", cached.length, "candidate(s)");
      return cached;
    }

    const baseUrl = 'https://db.ygoprodeck.com/api/v7/cardinfo.php?';

    // ─────────────────────────────────────────────────────────────
    // v9.0: LOCAL-FIRST SHORT-CIRCUIT
    // Try the local NamesStore against the *cleaned* OCR query before any
    // network call. If we get a high-confidence match, resolve that one card
    // by exact ?name= to populate sets/rarities, cache, and return.
    // ─────────────────────────────────────────────────────────────
    // v9.1: split into two try blocks so a local HIT survives a flaky API.
    let localHitName = '';
    try {
      const NS = window.NamesStore;
      if (NS && typeof NS.findBest === 'function' && NS.size() > 0) {
        // Build the cleanest probe we can from the raw OCR text
        const cleanProbe = stripTrailingOcrNoise(sanitizeForApi(raw));
        const probe = (cleanProbe && cleanProbe.length >= 3) ? cleanProbe : exact;
        // CONSOLE-OFF v12 console.log('[resolve] local probe:', JSON.stringify(probe), '(raw:', JSON.stringify(raw) + ')');
        const hit = NS.findBest(probe, { minScore: 0.85 });
        if (hit && hit.name) {
          // CONSOLE-OFF v12 console.log('[resolve] local HIT:', hit.name, 'score', hit.score.toFixed(3));
          localHitName = hit.name;
        } else {
          // CONSOLE-OFF v12 console.log('[resolve] local miss; falling through to API');
        }
      } else if (NS && NS.size() === 0) {
        // CONSOLE-OFF v12 console.log('[resolve] NamesStore not ready yet (size=0); skipping local short-circuit');
      }
    } catch (e) {
      // CONSOLE-OFF v12 console.warn('[resolve] local short-circuit threw, falling through:', e);
    }

    // If local matched, enrich with set/rarity data.
    // PRIORITY: CardDb (local IndexedDB snapshot) FIRST, then YGOPRODeck API.
    // This keeps the scan path fully offline-capable and avoids live API calls
    // for every scan when the local DB is loaded.
    if (localHitName) {
      // ── Step 1: try local CardDb first ──────────────────────────────────────
      try {
        if (window.CardDb && typeof window.CardDb.lookupByName === 'function') {
          if (typeof window.CardDb.ready === 'function') {
            try { await window.CardDb.ready(); } catch (_) {}
          }
          const local = await window.CardDb.lookupByName(localHitName);
          if (local && Array.isArray(local.sets) && local.sets.length) {
            const enriched = [{ id: local.id, name: local.name, sets: local.sets }];
            indexByName(enriched);
            setCached(exact || fuzzy, enriched);
            // CONSOLE-OFF v12 console.log('[api] fetchCandidates done via LOCAL DB for', raw, '→', enriched[0].sets.length, 'set(s)');
            return enriched;
          }
        }
      } catch (_) {}

      // ── Step 2: CardDb miss (new card / stale snapshot) → YGOPRODeck ────────
      try {
        const urlOne = baseUrl + new URLSearchParams({ name: localHitName }).toString();
        const dataOne = await fetchJson(urlOne, { timeoutMs: 3000 });
        const listOne = Array.isArray(dataOne?.data) ? dataOne.data : [];
        if (listOne.length) {
          const enriched = listOne.map(c => ({ id: c.id, name: c.name, sets: c.card_sets || [] }));
          indexByName(enriched);
          setCached(exact || fuzzy, enriched);
          // CONSOLE-OFF v12 console.log('[api] fetchCandidates done via LOCAL+API-enrich for', raw, '→', enriched.length, 'candidate(s)');
          return enriched;
        }
        // CONSOLE-OFF v12 console.log('[resolve] API enrich returned empty; serving synthetic (NOT cached)');
      } catch (e) {
        // CONSOLE-OFF v12 console.warn('[resolve] API enrich threw; serving synthetic (NOT cached):', e);
      }
      // v9.2: synthetic — name resolved but no sets yet. NOT cached so next
      // call retries enrichment.
      const synth = [{ id: null, name: localHitName, sets: [], __synthetic: true }];
      // CONSOLE-OFF v12 console.log('[api] fetchCandidates done via LOCAL-ONLY for', raw, '→ 1 candidate (no enrich, no cache)');
      return synth;
    }

    // v9.1: DO NOT include `misc=yes` on any cardinfo.php call. YGOPRODeck
    // currently 500s on (misc=yes + name=) and (misc=yes + multi-word fname=)
    // with "Database query parameter mismatch". `card_sets` is included by
    // default; we don't need misc fields for resolve.

    // 1) Exact name attempt (handles special chars)
    // v12 (#67): build the exact query from a SANITIZED name, not the raw OCR
    // string. The raw string can carry URL-significant junk (e.g. a trailing
    // "&l") that injects a stray query param and makes cardinfo.php?name= return
    // 400 Bad Request, spamming the console on every bad scan. nameQueryFromRaw
    // strips that junk and returns '' for non-name garbage, in which case we
    // skip the request entirely rather than emit a guaranteed 400.
    let out = [];
    const exactQuery = nameQueryFromRaw(exact);
    if (exactQuery) {
      const urlExact = baseUrl + new URLSearchParams({ name: exactQuery }).toString();
      // CONSOLE-OFF v12 console.log("[api] exact-name attempt:", exactQuery);
      const dataExact = await fetchJson(urlExact, { timeoutMs: 3000 });
      const listExact = Array.isArray(dataExact?.data) ? dataExact.data : [];
      // CONSOLE-OFF v12 console.log("[api] exact-name result:", listExact.length, "hit(s)");
      if (listExact.length) {
        out = listExact.map(c => ({ id: c.id, name: c.name, sets: c.card_sets || [] }));
      }
    }

    // 2) Fuzzy fallback if exact returned nothing.
    // v11 (#27): only fire when fname is actually queryable (single word, ≥3
    // chars). Multi-word fuzzy queries 400 upstream, so chunk to the longest
    // single word instead of sending the whole multi-word string.
    const fuzzyQ = isFnameQueryable(fuzzy) ? fuzzy : (strongestChunks(fuzzy)[0] || '');
    if (!out.length && isFnameQueryable(fuzzyQ)) {
      const urlFuzzy = baseUrl + new URLSearchParams({ fname: fuzzyQ }).toString();
      // CONSOLE-OFF v12 console.log("[api] fuzzy-name attempt:", fuzzyQ);
      const dataFuzzy = await fetchJson(urlFuzzy, { timeoutMs: 3000 });
      const listFuzzy = Array.isArray(dataFuzzy?.data) ? dataFuzzy.data : [];
      // CONSOLE-OFF v12 console.log("[api] fuzzy-name result:", listFuzzy.length, "hit(s)");
      if (listFuzzy.length) {
        out = listFuzzy.map(c => ({ id: c.id, name: c.name, sets: c.card_sets || [] }));
      }
    }

    // 3) v8.3b: stripped-tail fallback — retry with trailing OCR noise removed.
    // Common case: "Clown Crew Meteor 68" → "Clown Crew Meteor".
    // v11 (#27): same single-word-fname guard; skip if not queryable or dup.
    const strippedQ = isFnameQueryable(stripped) ? stripped : (strongestChunks(stripped)[0] || '');
    if (!out.length && isFnameQueryable(strippedQ) && strippedQ !== fuzzyQ) {
      const urlStripped = baseUrl + new URLSearchParams({ fname: strippedQ }).toString();
      // CONSOLE-OFF v12 console.log("[api] stripped-tail attempt:", strippedQ, "(from:", fuzzy + ")");
      const dataStripped = await fetchJson(urlStripped, { timeoutMs: 3000 });
      const listStripped = Array.isArray(dataStripped?.data) ? dataStripped.data : [];
      // CONSOLE-OFF v12 console.log("[api] stripped-tail result:", listStripped.length, "hit(s)");
      if (listStripped.length) {
        out = listStripped.map(c => ({ id: c.id, name: c.name, sets: c.card_sets || [] }));
      }
    } else if (!out.length && strippedQ === fuzzyQ) {
      // CONSOLE-OFF v12 console.log("[api] stripped-tail skipped — same as fuzzy:", fuzzyQ);
    }

    indexByName(out);
    setCached(exact || fuzzy, out);
    // CONSOLE-OFF v12 console.log("[api] fetchCandidates done for", raw, "→", out.length, "candidate(s)");
    return out;
  }

  async function fetchCardSetsAndRarities(cardName) {
    const key = (cardName || '').toLowerCase();
    if (!key) return { sets: [], raritiesMap: {} };

    const hit = _byName.get(key);
    if (hit && Array.isArray(hit.sets) && hit.sets.length) {
      return buildSetsAndRaritiesFromCard(hit);
    }

    // DB-1 (#50): LOCAL CARD DB FIRST. The local snapshot is the source of
    // truth for name → printings/sets/rarities; only fall through to the live
    // API when the local DB misses (older snapshot / brand-new card). #52 will
    // formalize the failure/fallback policy.
    try {
      if (window.CardDb && typeof window.CardDb.lookupByName === 'function') {
        // Wait for the initial snapshot import to finish before treating a local
        // miss as authoritative — otherwise an in-flight import yields false
        // misses and avoidable YGOPRODeck fallback calls. ready() is best-effort:
        // if it rejects, fall through to the remote path rather than throwing.
        if (typeof window.CardDb.ready === 'function') {
          try { await window.CardDb.ready(); } catch (_) { /* best-effort: fall through to remote */ }
        }
        const local = await window.CardDb.lookupByName(cardName);
        if (local && Array.isArray(local.sets) && local.sets.length) {
          indexByName([{ id: local.id, name: local.name, sets: local.sets }]);
          // CONSOLE-OFF v12 console.log('[api] fetchCardSetsAndRarities: LOCAL DB hit for', cardName, '→', local.sets.length, 'set(s)');
          return buildSetsAndRaritiesFromCard(local);
        }
      }
    } catch (e) {
      // CONSOLE-OFF v12 console.warn('[api] local CardDb lookup threw; falling through to API:', e);
    }

    // v9.2: Always try exact `?name=` first — it's the most reliable path and
    // returns card_sets in the default response. This is the workhorse for the
    // safety-net call from lookup.js when a synthetic candidate landed in state.
    if (hasMinLen3(cardName)) {
      const urlExact = 'https://db.ygoprodeck.com/api/v7/cardinfo.php?' +
                       new URLSearchParams({ name: cardName }).toString();
      const data = await fetchJson(urlExact, { timeoutMs: 3000 });
      const list = Array.isArray(data?.data) ? data.data : [];
      if (list.length) {
        const card = { id: list[0].id, name: list[0].name, sets: list[0].card_sets || [] };
        indexByName([card]);
        // CONSOLE-OFF v12 console.log('[api] fetchCardSetsAndRarities: filled via exact ?name= for', cardName, '→', card.sets.length, 'set(s)');
        return buildSetsAndRaritiesFromCard(card);
      }
    }

    // Fallback: try strongest chunks against fname (single-word chunks only —
    // upstream currently rejects multi-word fname queries with HTTP 500).
    for (const q of strongestChunks(cardName)) {
      const url = 'https://db.ygoprodeck.com/api/v7/cardinfo.php?' +
                  new URLSearchParams({ fname: q }).toString();

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
  // v7: default minScore unified to 0.73 (same as resolve.js SIM_ACCEPT)
  async function resolveNameFromScanNgrams(raw, { minScore = 0.73 } = {}) {
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

  // v9.3: Resilient safety-net helper. Given a candidate object with empty/missing
  // sets, try a sequence of upstream lookups until one returns card_sets. Mutates
  // the candidate in place. Returns true on success.
  function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function _commitSets(candidate, listItem) {
    const sets = listItem?.card_sets || [];
    if (!sets.length) return false;
    candidate.sets = sets;
    if (!candidate.id && listItem.id) candidate.id = listItem.id;
    if (candidate.__synthetic) delete candidate.__synthetic;
    indexByName([{ id: candidate.id, name: candidate.name, sets }]);
    return true;
  }

  // v10.5: race combinator — resolves to the first promise that yields a
  // non-null, "non-empty" value (truthy + has card_sets[] with length).
  // Returns null if ALL settle to null/empty/reject.
  //   tasks: array of () => Promise<cardLike|null>
  function _firstNonEmpty(tasks) {
    return new Promise(resolve => {
      let remaining = tasks.length;
      if (!remaining) return resolve(null);
      let resolved = false;
      const finish = (val) => { if (!resolved) { resolved = true; resolve(val); } };
      tasks.forEach((task, idx) => {
        Promise.resolve()
          .then(() => task())
          .then(val => {
            const sets = val && (val.card_sets || []);
            if (val && Array.isArray(sets) && sets.length > 0) {
              // CONSOLE-OFF v12 console.log('[api] fillSets race: path', idx, 'WON with', sets.length, 'set(s)');
              finish(val);
            } else {
              if (--remaining === 0) finish(null);
            }
          })
          .catch(e => {
            // CONSOLE-OFF v12 console.warn('[api] fillSets race: path', idx, 'threw:', e);
            if (--remaining === 0) finish(null);
          });
      });
    });
  }

  async function fillSetsForCandidate(candidate) {
    if (!candidate || !candidate.name) return false;
    if (Array.isArray(candidate.sets) && candidate.sets.length > 0) return true;

    const baseUrl = 'https://db.ygoprodeck.com/api/v7/cardinfo.php?';
    const want = String(candidate.name).toLowerCase();
    const chunks = strongestChunks(candidate.name);
    const t0 = Date.now();
    // CONSOLE-OFF v12 console.log('[api] fillSets v10.5 RACE start for', candidate.name);

    // Each path is an async fn returning a card-like object
    //   { id, name, card_sets: [...] }   on success,
    //   null                              on failure / empty / no exact match

    // Path A — exact ?name= (single attempt, no retry loop)
    // v17 (#27): guard against empty/too-short names that YGOPRODeck answers
    // with a 400 (which the browser logs before fetchJson can swallow it).
    const pathName = async () => {
      if (!isNameQueryable(candidate.name)) return null;
      const url = baseUrl + new URLSearchParams({ name: candidate.name }).toString();
      const data = await fetchJson(url, { timeoutMs: 3500 });
      const list = Array.isArray(data?.data) ? data.data : [];
      return list[0] || null;
    };

    // Path B — ?id= (different upstream code path)
    const pathId = async () => {
      if (!candidate.id) return null;
      const url = baseUrl + new URLSearchParams({ id: String(candidate.id) }).toString();
      const data = await fetchJson(url, { timeoutMs: 3500 });
      const list = Array.isArray(data?.data) ? data.data : [];
      return list[0] || null;
    };

    // Path C — ?fname= (fuzzy on longest-word chunk; pick exact name match)
    // v17 (#27): only query when the chunk passes the fname guard (≥3 chars,
    // single word) — prevents the upstream 400s that flooded the console.
    const pathFname = async () => {
      if (!chunks.length || !isFnameQueryable(chunks[0])) return null;
      const url = baseUrl + new URLSearchParams({ fname: chunks[0] }).toString();
      const data = await fetchJson(url, { timeoutMs: 3500 });
      const list = Array.isArray(data?.data) ? data.data : [];
      return list.find(c => (c?.name || '').toLowerCase() === want) || null;
    };

    // Paths D & E (corsproxy ?name= / ?fname=) REMOVED in v17 (#27 console
    // hygiene). corsproxy.io now returns 403 (Forbidden) for every request,
    // so these fallbacks contributed nothing but a red "403" line to the
    // console on every lookup (the browser logs the network failure before JS
    // can swallow it). The direct Paths A–C plus the reliable cardset-scan
    // (Path F) already cover lookups. If a CORS-friendly proxy is needed in
    // future, reintroduce via a backend endpoint we control.

    // Path F — cardset-scan via codeSearch (the reliable workhorse).
    //   Fetches master set list, takes 40 most recent TCG sets, queries each
    //   in parallel batches of 8 for its cards, returns first match.
    const pathCardsetScan = async () => {
      const cs = window.LookupParts?.codeSearch || window.Lookup?.codeSearch;
      if (!cs || typeof cs.fetchSetsList !== 'function') {
        // CONSOLE-OFF v12 console.log('[api] fillSets cardset-scan unavailable — codeSearch missing');
        return null;
      }
      const allSets = await cs.fetchSetsList();
      if (!Array.isArray(allSets) || !allSets.length) return null;
      const MAX_SETS = 40;
      const sorted = allSets
        .filter(s => s && s.set_name)
        .map(s => ({ ...s, _d: s.tcg_date ? new Date(s.tcg_date).getTime() : 0 }))
        .sort((a, b) => b._d - a._d)
        .slice(0, MAX_SETS);
      const CHUNK = 8;
      for (let i = 0; i < sorted.length; i += CHUNK) {
        const slice = sorted.slice(i, i + CHUNK);
        const results = await Promise.all(slice.map(s => (async () => {
          try {
            const u = baseUrl + new URLSearchParams({ cardset: s.set_name }).toString();
            const data = await fetchJson(u, { timeoutMs: 5000 });
            const arr = Array.isArray(data?.data) ? data.data : [];
            return { setName: s.set_name, cards: arr };
          } catch (_) {
            return { setName: s.set_name, cards: [] };
          }
        })()));
        for (const r of results) {
          const hit = r.cards.find(c => (c?.name || '').toLowerCase() === want);
          if (hit) {
            // CONSOLE-OFF v12 console.log('[api] fillSets cardset-scan: FOUND', candidate.name, 'in set', r.setName,
                        // CONSOLE-OFF v12 '→', (hit.card_sets || []).length, 'printing(s)');
            return hit;
          }
        }
      }
      return null;
    };

    // RACE — first non-empty wins.
    const winner = await _firstNonEmpty([
      pathName,         // 0
      pathId,           // 1
      pathFname,        // 2
      pathCardsetScan,  // 3  (corsproxy Paths D/E removed — v17 #27)
    ]);

    const elapsed = Date.now() - t0;
    if (winner && _commitSets(candidate, winner)) {
      // CONSOLE-OFF v12 console.log('[api] fillSets ok via RACE —', candidate.name, '→', candidate.sets.length, 'set(s) in', elapsed + 'ms');
      return true;
    }
    // CONSOLE-OFF v12 console.warn('[api] fillSetsForCandidate: ALL paths exhausted for', candidate.name, 'after', elapsed + 'ms');
    return false;
  }

  // v13.3: synchronous cache hit — returns { id, name, sets } or null without touching the network.
  function getCachedByName(name) {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return null;
    const hit = _byName.get(key);
    return hit || null;
  }

  // Public API
  const api = {
    fetchCandidates,
    fetchCardSetsAndRarities,
    fillSetsForCandidate, // v9.2
    bestNameMatch: resolveNameFromScanNgrams,
    resolveNameFromScanNgrams,
    // NEW:
    fetchCardPrice, // returns number (e.g., 0.17) or "" if unavailable
    // v13.3:
    getCachedByName, // synchronous lookup of in-memory _byName cache
  };

  Object.assign(window.Lookup, api);
  window.LookupParts.api = api;
})();
