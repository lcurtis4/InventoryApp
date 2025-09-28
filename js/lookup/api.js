// js/lookup/api.js
(function () {
  'use strict';

  // Ensure namespaces
  window.LookupParts = window.LookupParts || {};
  window.Lookup = window.Lookup || {};

  /* -------------------------------------------------------
   * Normalization + similarity helpers
   * (quotes stripped for fuzzy work; joiners normalized)
   * ----------------------------------------------------- */
  function norm(s) {
    if (!s) return "";
    let t = String(s);

    // 1) Remove quotes (straight + curly) so OCR like `"Ripper"` ≈ Ripper
    t = t.replace(/[“”"‘’`]/g, "");

    // 2) unify star/dot joiners; normalize kana dot variants
    t = t.replace(/[★]/g, "☆").replace(/[・]/g, "·");

    // 3) collapse weird punctuation to spaces but allow these: - : & ! ? , . and star/dots
    t = t
      .replace(/[^\w\s\-\:\&\!\?\,\.☆・·]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

    // normalize spaced hyphens & collapse multiple middle dots
    t = t.replace(/\s*-\s*/g, "-");
    t = t.replace(/[·]{2,}/g, "·");
    return t;
  }

  // Minimum length check (letters/digits only) before any DB calls
  function hasMinLen3(raw) {
    if (!raw) return false;
    const cleaned = norm(raw).replace(/[^a-z0-9]/g, "");
    return cleaned.length >= 3;
  }

  // Levenshtein similarity 0..1
  function levPct(a, b) {
    a = norm(a); b = norm(b);
    if (!a || !b) return 0;
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const c = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + c
        );
      }
    }
    const dist = dp[m][n];
    return 1 - dist / Math.max(m, n);
  }

  // Jaro-Winkler similarity 0..1
  function jwPct(s1, s2) {
    const M = Math;
    s1 = norm(s1); s2 = norm(s2);
    if (!s1 || !s2) return 0;

    const matchDist = M.floor(M.max(s1.length, s2.length) / 2) - 1;
    const aM = new Array(s1.length), bM = new Array(s2.length);
    let matches = 0, trans = 0;

    for (let i = 0; i < s1.length; i++) {
      const start = M.max(0, i - matchDist), end = M.min(i + matchDist + 1, s2.length);
      for (let k = start; k < end; k++) {
        if (bM[k]) continue;
        if (s1[i] === s2[k]) { aM[i] = bM[k] = true; matches++; break; }
      }
    }
    if (matches === 0) return 0;

    let k = 0;
    for (let i = 0; i < s1.length; i++) {
      if (!aM[i]) continue;
      while (!bM[k]) k++;
      if (s1[i] !== s2[k]) trans++;
      k++;
    }
    const jaro = ((matches / s1.length) + (matches / s2.length) + ((matches - trans / 2) / matches)) / 3;
    let prefix = 0;
    for (let i = 0; i < M.min(4, s1.length, s2.length); i++) {
      if (s1[i] === s2[i]) prefix++; else break;
    }
    return jaro + prefix * 0.1 * (1 - jaro);
  }

  const sim = (a, b) => Math.max(levPct(a, b), jwPct(a, b));

  /* -------------------------------------------------------
   * Query builders
   * ----------------------------------------------------- */
  function splitBySpaces(s) {
    return String(s || "").trim().split(/\s+/).filter(Boolean);
  }
  function splitHyphenTokens(tokens) {
    const out = [];
    for (const tok of tokens) {
      if (tok.includes("-")) out.push(...tok.split("-"));
      else out.push(tok);
    }
    return out;
  }
  function sanitizeTokens(tokens) {
    return tokens.filter(t => {
      if (!/[a-z]/i.test(t) && !/\d/.test(t)) return false;
      if (t === "&") return false;
      if (t.length < 2 && !/\d/.test(t)) return false;
      return true;
    });
  }
  function toGoodBase(raw) {
    let s = norm(raw);
    if (!s) return "";
    s = s.replace(/\s*:\s*/g, ": ").replace(/\s{2,}/g, " ").trim();
    if (s.length < 4 || !/[a-z]/i.test(s)) return "";
    return s;
  }
  function ngrams(raw) {
    const tokens = sanitizeTokens(splitHyphenTokens(splitBySpaces(norm(raw))));
    if (!tokens.length) return [];
    const out = new Set();
    for (let i = 0; i < tokens.length; i++) {
      const a = tokens[i];
      if (i + 1 < tokens.length) out.add(`${a} ${tokens[i + 1]}`);
      if (i + 2 < tokens.length) out.add(`${a} ${tokens[i + 2]}`);
    }
    return Array.from(out).slice(0, 12);
  }
  function strongestChunks(raw) {
    const tries = ngrams(raw);
    const weighted = tries.map(t => ({ t, w: t.length }));
    weighted.sort((a, b) => b.w - a.w);
    return weighted.map(x => x.t);
  }

  /* -------------------------------------------------------
   * Caches
   * ----------------------------------------------------- */
  const _queryCache = new Map(); // key: q, val: { ts, cards }
  const CACHE_MS = 15_000;

  function getCached(q) {
    const e = _queryCache.get(q);
    if (!e) return null;
    if (Date.now() - e.ts > CACHE_MS) { _queryCache.delete(q); return null; }
    return e.cards;
  }
  function setCached(q, cards) { _queryCache.set(q, { ts: Date.now(), cards }); }

  // Cache full cards by exact DB name (lowercased), so we can reuse card_sets later
  const _byName = new Map(); // key: name.toLowerCase(), val: { id, name, sets: [...] }
  function indexByName(cards) {
    if (!Array.isArray(cards)) return;
    for (const c of cards) {
      const key = (c?.name || "").toLowerCase();
      if (key && !_byName.has(key)) _byName.set(key, c);
    }
  }

  /* -------------------------------------------------------
   * Network helpers
   * ----------------------------------------------------- */
  async function fetchJson(url, { timeoutMs = 3000 } = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: "GET", signal: ctl.signal });
      if (!res.ok) return null; // 4xx/5xx -> null; don't throw
      return await res.json();
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  }

  /* -------------------------------------------------------
   * Candidate search (fname)
   * ----------------------------------------------------- */
  async function fetchCandidates(raw) {
    const q = toGoodBase(raw);
    if (!q || !hasMinLen3(q)) return [];

    const cached = getCached(q);
    if (cached) return cached;

    const url = "https://db.ygoprodeck.com/api/v7/cardinfo.php?misc=yes&fname=" + encodeURIComponent(q);
    const data = await fetchJson(url, { timeoutMs: 3000 });

    const list = Array.isArray(data?.data) ? data.data : [];
    const out = list.map(c => ({ id: c.id, name: c.name, sets: c.card_sets || [] }));
    indexByName(out);
    setCached(q, out);
    return out;
  }

  /* -------------------------------------------------------
   * Resolve scanned name (n-grams) → confident exact DB name
   * ----------------------------------------------------- */
  const SIM_ACCEPT = 0.75;

  function bestNameIndexWithScore(q, candidates) {
    let best = -1, bestScore = -Infinity;
    for (let i = 0; i < candidates.length; i++) {
      const score = sim(q, candidates[i]?.name || "");
      if (score > bestScore) { bestScore = score; best = i; }
    }
    return { idx: best, score: bestScore };
  }

  async function resolveNameFromScanNgrams(arg1, arg2, arg3) {
    let raw = arg1;
    let manualName = "";
    let scannedName = "";
    if (typeof arg1 === "object" && arg1) {
      manualName = (arg1.manualName || "").trim();
      scannedName = (arg1.scannedName || "").trim();
    } else {
      manualName = (arg2 || "").trim();
      scannedName = (arg3 || "").trim();
    }

    if (manualName) return manualName;
    if (scannedName) raw = scannedName;
    raw = (raw || "").trim();
    if (!raw) return "";

    if (!hasMinLen3(raw)) return "";

    const candidates = await fetchCandidates(raw);
    if (!candidates.length) return "";

    const { idx, score } = bestNameIndexWithScore(raw, candidates);
    if (idx < 0) return "";
    if (score >= SIM_ACCEPT) {
      return candidates[idx].name || "";
    }
    return ""; // not confident enough
  }

  /* -------------------------------------------------------
   * Sets & rarities helpers
   * ----------------------------------------------------- */
  function buildSetsAndRaritiesFromCard(card) {
    const rawSets = card?.sets || card?.card_sets || [];
    const setMap = new Map();
    const rarityMap = {};
    const rarityMetaMap = {};
    const setPriceMap = {};
    for (const s of rawSets) {
      const code = (s?.set_code || "").trim();
      const name = (s?.set_name || "").trim();
      const rarity = (s?.set_rarity || "").trim();
      const rarity_code = (s?.set_rarity_code || "").trim();
      const set_price = s?.set_price != null ? String(s.set_price) : undefined;
      if (!code || !name) continue;
      if (!setMap.has(code)) setMap.set(code, name);

      if (!rarityMap[code]) rarityMap[code] = new Set();
      if (rarity) rarityMap[code].add(rarity);

      if (!rarityMetaMap[code]) rarityMetaMap[code] = new Map();
      if (rarity) {
        const key = rarity;
        if (!rarityMetaMap[code].has(key)) {
          rarityMetaMap[code].set(key, { rarity, rarity_code: rarity_code || undefined });
        }
      }

      if (set_price !== undefined) {
        if (!setPriceMap[code]) setPriceMap[code] = new Set();
        setPriceMap[code].add(set_price);
      }
    }
    const sets = Array.from(setMap.entries())
      .map(([code, name]) => ({ code, name }))
      .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
    const raritiesMap = {};
    Object.keys(rarityMap).forEach((code) => {
      raritiesMap[code] = Array.from(rarityMap[code]).sort((a, b) => a.localeCompare(b));
    });
    const raritiesMetaMap = {};
    Object.keys(rarityMetaMap).forEach((code) => {
      raritiesMetaMap[code] = Array.from(rarityMetaMap[code].values());
    });
    const setPriceMapOut = {};
    Object.keys(setPriceMap).forEach((code) => {
      setPriceMapOut[code] = Array.from(setPriceMap[code].values());
    });
    return { sets, raritiesMap, raritiesMetaMap, setPriceMap: setPriceMapOut };
  }

  function nameVariants(cardName) {
    const base0 = String(cardName || "").trim(); // exact
    const base = base0.replace(/★/g, "☆");
    const joiners = ["-", "☆", "・", "·", " "];
    const out = new Set([base, base0]);
    const parts = base.split(/\s+/);

    if (parts.length >= 2) {
      const firstA = parts[0], firstB = parts[1];
      const lastA = parts[parts.length - 2], lastB = parts[parts.length - 1];
      for (const j of joiners) {
        out.add(`${firstA}${j}${firstB}`);
        out.add(`${lastA}${j}${lastB}`);
      }
    }
    return Array.from(out);
  }

  async function fetchCardSetsAndRarities(cardName) {
    const key = (cardName || "").toLowerCase();
    if (!key) return { sets: [], raritiesMap: {} };

    // 1) Already in by-name cache (from candidate searches)
    const hit = _byName.get(key);
    if (hit) return buildSetsAndRaritiesFromCard(hit);

    // 2) Try exact name first (variants to handle joiner swaps)
    const variants = nameVariants(cardName);
    for (const v of variants) {
      const data = await fetchJson(
        "https://db.ygoprodeck.com/api/v7/cardinfo.php?misc=yes&name=" + encodeURIComponent(v),
        { timeoutMs: 3000 }
      );
      const card = Array.isArray(data?.data) ? data.data[0] : null;
      if (card && Array.isArray(card.card_sets) && card.card_sets.length) {
        const slim = { id: card.id, name: card.name, sets: card.card_sets };
        indexByName([slim]);
        return buildSetsAndRaritiesFromCard(slim);
      }
    }

    // 3) Last-resort: fname with strong chunks, then choose best by similarity
    for (const q of strongestChunks(cardName)) {
      const data = await fetchJson(
        "https://db.ygoprodeck.com/api/v7/cardinfo.php?misc=yes&fname=" + encodeURIComponent(q),
        { timeoutMs: 3000 }
      );
      const list = Array.isArray(data?.data) ? data.data : [];
      if (!list.length) continue;

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

  /* -------------------------------------------------------
   * Full details fetch
   * ----------------------------------------------------- */
  async function fetchCardDetails({ id, name } = {}) {
    const base = "https://db.ygoprodeck.com/api/v7/cardinfo.php?misc=yes";
    let urls = [];
    if (id) urls.push(base + "&id=" + encodeURIComponent(String(id)));
    const safeName = (name || "").trim();
    if (!id && safeName) {
      urls.push(base + "&name=" + encodeURIComponent(safeName));
      urls.push(base + "&fname=" + encodeURIComponent(safeName));
    }

    for (const url of urls) {
      const data = await fetchJson(url, { timeoutMs: 4000 });
      const card = Array.isArray(data?.data) ? data.data[0] : null;
      if (!card) continue;

      return {
        id: card.id,
        name: card.name,
        type: card.type,
        desc: card.desc,
        race: card.race,
        archetype: card.archetype,
        atk: card.atk,
        def: card.def,
        level: card.level,
        linkval: card.linkval,
        scale: card.scale,
        card_sets: Array.isArray(card.card_sets) ? card.card_sets : [],
        card_images: Array.isArray(card.card_images) ? card.card_images : [],
        card_prices: Array.isArray(card.card_prices) ? card.card_prices : [],
        banlist_info: card.banlist_info || null,
        misc_info: card.misc_info || null
      };
    }
    return null;
  }

  /* -------------------------------------------------------
   * Public API surface
   * ----------------------------------------------------- */

  // Pull bestNameMatch from normalize (loaded earlier). If not present, safe no-op.
  const bestNameMatch =
    (window.Lookup && window.Lookup.normalize && window.Lookup.normalize.bestNameMatch)
      ? window.Lookup.normalize.bestNameMatch
      : function () { return 0; };

  const api = {
    fetchCardDetails,
    fetchCandidates,
    resolveNameFromScanNgrams,
    fetchCardSetsAndRarities,
    bestNameMatch, // legacy use
  };

  Object.assign(window.Lookup, api);
  window.Lookup.api = api;
  window.LookupParts.api = api;

  // Back-compat for older UI code that calls `lookup.*`
  window.lookup = window.Lookup;
})();
