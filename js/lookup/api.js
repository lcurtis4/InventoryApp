// js/lookup/api.js
(function () {
  'use strict';

  // Ensure namespaces
  window.LookupParts = window.LookupParts || {};
  window.Lookup = window.Lookup || {};

  /* -------------------------------------------------------
   * Normalization + similarity helpers
   * ----------------------------------------------------- */
  function norm(s) {
    if (!s) return "";
    let t = String(s);
    t = t.replace(/[“”"‘’`]/g, "");
    t = t.replace(/[★]/g, "☆").replace(/[・]/g, "·");
    t = t
      .replace(/[^\w\s\-\:\&\!\?\,\.☆・·]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    t = t.replace(/\s*-\s*/g, "-");
    t = t.replace(/[·]{2,}/g, "·");
    return t;
  }

  function hasMinLen3(raw) {
    if (!raw) return false;
    const cleaned = norm(raw).replace(/[^a-z0-9]/g, "");
    return cleaned.length >= 3;
  }

  // ... [unchanged helper functions above] ...

  /* -------------------------------------------------------
   * Candidate search (fname)
   * ----------------------------------------------------- */
  async function fetchCandidates(raw) {
    const q = toGoodBase(raw);
    if (!q || !hasMinLen3(q)) return [];

    console.log("[API Lookup] fetchCandidates fname:", q);

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
   * Sets & rarities helpers
   * ----------------------------------------------------- */
  async function fetchCardSetsAndRarities(cardName) {
    const key = (cardName || "").toLowerCase();
    if (!key) return { sets: [], raritiesMap: {} };

    console.log("[API Lookup] fetchCardSetsAndRarities name:", cardName);

    const hit = _byName.get(key);
    if (hit) return buildSetsAndRaritiesFromCard(hit);

    const variants = nameVariants(cardName);
    for (const v of variants) {
      console.log("[API Lookup] trying variant:", v);

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

    for (const q of strongestChunks(cardName)) {
      console.log("[API Lookup] fallback fname chunk:", q);

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
      console.log("[API Lookup] fetchCardDetails by name:", safeName);

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
  const bestNameMatch =
    (window.Lookup && window.Lookup.normalize && window.Lookup.normalize.bestNameMatch)
      ? window.Lookup.normalize.bestNameMatch
      : function () { return 0; };

  const api = {
    fetchCardDetails,
    fetchCandidates,
    resolveNameFromScanNgrams,
    fetchCardSetsAndRarities,
    bestNameMatch,
  };

  Object.assign(window.Lookup, api);
  window.Lookup.api = api;
  window.LookupParts.api = api;

  window.lookup = window.Lookup;
})();
