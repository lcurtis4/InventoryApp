// js/lookup/resolve.js  — v9.2
// v9.2: Pass through api.fillSetsForCandidate so lookup.js can use the safety-net
//       on window.Lookup.* without depending on internal namespaces.
// v9.1: No behavior change here — the local-first short-circuit lives inside
//       api.fetchCandidates(), which both resolveNameFromScanNgrams() and
//       resolveTopCandidates() already route through. This file keeps its
//       v7.1 scoring + threshold logic intact.
// v7.1: unified threshold, top-3 candidate exposure
(function () {
  'use strict';
  // CONSOLE-OFF v12 console.log('[resolve] module loaded — v9.2 (exposes fillSetsForCandidate)');

  // Namespaces
  window.LookupParts = window.LookupParts || {};
  window.Lookup = window.Lookup || {};

  // Upstream helpers (API + normalize)
  const A = window.LookupParts.api || window.Lookup;                    // fetchCandidates, fetchCardSetsAndRarities, bestNameMatch
  const N = window.LookupParts.normalize || window.Lookup.normalize || {};

  // Unified confidence threshold — v7: standardized to 0.73 (was 0.75 here, 0.65 in api.js)
  const SIM_ACCEPT = 0.73;

  // Safe helpers
  const fetchCandidates =
    (A && typeof A.fetchCandidates === "function") ? A.fetchCandidates : async () => [];
  const sim =
    (N && typeof N.sim === "function") ? N.sim : (a, b) => (String(a) === String(b) ? 1 : 0);
  const norm =
    (N && typeof N.norm === "function") ? N.norm : (s) => (s || "").toString().trim().toLowerCase();

  // All indices + scores, sorted by score desc
  function scoredCandidates(query, candidates) {
    if (!Array.isArray(candidates) || !candidates.length) return [];
    const nq = norm(query);
    return candidates
      .map((c, i) => {
        const name = c?.name || "";
        if (!name) return null;
        const score = sim(query, name) + (norm(name).startsWith(nq) ? 0.05 : 0);
        return { idx: i, score, candidate: c };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
  }

  // Best index + score with tiny prefix bonus
  function bestIndexWithScore(query, candidates) {
    const scored = scoredCandidates(query, candidates);
    if (!scored.length) return { idx: -1, score: -Infinity };
    return { idx: scored[0].idx, score: scored[0].score };
  }

  // Resolve a canonical name from OCR/manual inputs with fuzzy acceptance
  async function resolveNameFromScanNgrams(arg1, arg2, arg3) {
    let manualName = "", scannedName = "", raw = "";

    if (typeof arg1 === "string") {
      raw = (arg1 || "").trim();
    } else if (arg1 && typeof arg1 === "object" && !Array.isArray(arg1)) {
      manualName = (arg1.manualName || "").trim();
      scannedName = (arg1.scannedName || "").trim();
    } else if (Array.isArray(arg1)) {
      manualName = (arg2 || "").trim();
      scannedName = (arg3 || "").trim();
    }

    // Manual always wins
    if (manualName) return manualName;

    if (scannedName) raw = scannedName;
    raw = (raw || "").trim();
    if (!raw) return "";

    const candidates = await fetchCandidates(raw);
    if (!Array.isArray(candidates) || !candidates.length) return "";

    const { idx, score } = bestIndexWithScore(raw, candidates);

    // Only accept & return if we're confident enough
    if (idx >= 0 && score >= SIM_ACCEPT) {
      return candidates[idx].name || "";
    }

    // Not confident → return empty so the scanner keeps going
    return "";
  }

  /**
   * v7.1: Returns top-N scored candidates (default 3) for use in the multi-candidate picker UI.
   * Each item: { name, score, id, imageUrl }
   * Callers should check result.length — if 0, no useful candidates found.
   *
   * FIX 3: v7 returned candidates regardless of score, so a completely garbled OCR
   * read (score ~0.05) would still show the picker and pause the scanner, making
   * recovery impossible without a manual Rescan.  A minimum score of 0.30 is now
   * required; below that the result set is treated as empty so the scanner keeps
   * running and retries on the next stable frame.
   */
  const MIN_CANDIDATE_SCORE = 0.30;

  async function resolveTopCandidates(raw, { topN = 3 } = {}) {
    const query = (raw || "").trim();
    if (!query) return [];

    const candidates = await fetchCandidates(query);
    if (!Array.isArray(candidates) || !candidates.length) return [];

    const scored = scoredCandidates(query, candidates);
    // FIX 3: discard candidates whose best similarity is below the minimum threshold.
    const qualified = scored.filter(({ score }) => score >= MIN_CANDIDATE_SCORE);
    return qualified.slice(0, topN).map(({ score, candidate }) => {
      const id = candidate?.id;
      const imageUrl = id
        ? `https://images.ygoprodeck.com/images/cards_small/${id}.jpg`
        : null;
      return { name: candidate.name || "", score, id: id || null, imageUrl };
    });
  }

  const resolve = {
    resolveNameFromScanNgrams,
    resolveTopCandidates,
    fetchCardSetsAndRarities:
      (A && typeof A.fetchCardSetsAndRarities === "function")
        ? A.fetchCardSetsAndRarities
        : async () => ({ sets: [], raritiesMap: {} }),
    // v9.2: Safety-net for empty-sets candidates
    fillSetsForCandidate:
      (A && typeof A.fillSetsForCandidate === "function")
        ? A.fillSetsForCandidate
        : async () => false,
    // Keep exposing bestNameMatch if others depend on it (unchanged behavior)
    bestNameMatch:
      (A && typeof A.bestNameMatch === "function")
        ? A.bestNameMatch
        : (N && typeof N.bestNameMatch === "function")
          ? N.bestNameMatch
          : undefined
  };

  // Expose
  window.LookupParts.resolve = resolve;

  // Flatten so callers can use window.Lookup.* directly
  window.Lookup.resolveNameFromScanNgrams = resolveNameFromScanNgrams;
  window.Lookup.resolveTopCandidates = resolveTopCandidates;
  window.Lookup.fetchCardSetsAndRarities = resolve.fetchCardSetsAndRarities;
  window.Lookup.fillSetsForCandidate = resolve.fillSetsForCandidate;
  window.Lookup.bestNameMatch = resolve.bestNameMatch;
})();
