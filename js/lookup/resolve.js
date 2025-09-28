// js/lookup/resolve.js
(function () {
  'use strict';

  // Namespaces
  window.LookupParts = window.LookupParts || {};
  window.Lookup = window.Lookup || {};

  // Upstream helpers (API + normalize)
  const A = window.LookupParts.api || window.Lookup;                    // fetchCandidates, fetchCardSetsAndRarities, bestNameMatch
  const N = window.LookupParts.normalize || window.Lookup.normalize || {};

  // Accept a candidate only if similarity >= 0.75
  const SIM_ACCEPT = 0.75;

  // Safe helpers
  const fetchCandidates =
    (A && typeof A.fetchCandidates === "function") ? A.fetchCandidates : async () => [];
  const sim =
    (N && typeof N.sim === "function") ? N.sim : (a, b) => (String(a) === String(b) ? 1 : 0);
  const norm =
    (N && typeof N.norm === "function") ? N.norm : (s) => (s || "").toString().trim().toLowerCase();

  // Best index + score with tiny prefix bonus
  function bestIndexWithScore(query, candidates) {
    if (!Array.isArray(candidates) || !candidates.length) return { idx: -1, score: -Infinity };
    let bestIdx = -1, bestScore = -Infinity;
    const nq = norm(query);
    for (let i = 0; i < candidates.length; i++) {
      const name = candidates[i]?.name || "";
      if (!name) continue;
      const s = sim(query, name) + (norm(name).startsWith(nq) ? 0.05 : 0);
      if (s > bestScore) { bestScore = s; bestIdx = i; }
    }
    return { idx: bestIdx, score: bestScore };
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

  const resolve = {
    resolveNameFromScanNgrams,
    fetchCardSetsAndRarities:
      (A && typeof A.fetchCardSetsAndRarities === "function")
        ? A.fetchCardSetsAndRarities
        : async () => ({ sets: [], raritiesMap: {} }),
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

  // Flatten so callers can use window.Lookup.resolveNameFromScanNgrams directly
  window.Lookup.resolveNameFromScanNgrams = resolveNameFromScanNgrams;
  window.Lookup.fetchCardSetsAndRarities = resolve.fetchCardSetsAndRarities;
  window.Lookup.bestNameMatch = resolve.bestNameMatch;
})();
