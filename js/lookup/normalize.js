// js/lookup/normalize.js
(function () {
  'use strict';

  window.LookupParts = window.LookupParts || {};
  window.Lookup = window.Lookup || {};

  /** Normalize a name to a comparable form */
  function norm(s) {
    if (!s) return "";
    let t = String(s);

    // Remove quotes and unify some symbols commonly misread by OCR
    t = t.replace(/[“”"‘’`]/g, "");
    t = t.replace(/[★]/g, "☆").replace(/[・]/g, "·");

    // Keep safe chars: letters, digits, space, hyphen and a few punctuation marks
    t = t.replace(/[^\w\s\-\&\!\?:,\.]/g, " ");

    // Collapse spaces and normalize spaced hyphens
    t = t.replace(/\s+/g, " ").trim();
    t = t.replace(/\s*-\s*/g, "-");

    // Lower for similarity functions
    return t.toLowerCase();
  }

  /** Levenshtein similarity in 0..1 */
  function levPct(a, b) {
    a = norm(a); b = norm(b);
    if (!a || !b) return 0;
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const c = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + c);
      }
    }
    const dist = dp[m][n];
    return 1 - dist / Math.max(m, n);
  }

  /** Jaro–Winkler similarity 0..1 */
  function jwPct(s1, s2) {
    s1 = norm(s1); s2 = norm(s2);
    if (!s1 || !s2) return 0;

    const M = Math;
    const matchDist = M.floor(M.max(s1.length, s2.length) / 2) - 1;
    const aM = new Array(s1.length), bM = new Array(s2.length);
    let matches = 0, trans = 0;

    for (let i = 0; i < s1.length; i++) {
      const start = M.max(0, i - matchDist), end = M.min(i + matchDist + 1, s2.length);
      for (let k = start; k < end; k++) {
        if (bM[k]) continue;
        if (s1[i] !== s2[k]) continue;
        aM[i] = bM[k] = true;
        matches++; break;
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
    const j = ((matches / s1.length) + (matches / s2.length) + ((matches - trans / 2) / matches)) / 3;
    const prefixMax = 4;
    let prefix = 0; for (let i = 0; i < Math.min(prefixMax, s1.length, s2.length); i++) { if (s1[i] === s2[i]) prefix++; else break; }
    return j + prefix * 0.1 * (1 - j);
  }

  /** Hybrid similarity 0..1 */
  function sim(a, b) { return Math.max(levPct(a, b), jwPct(a, b)); }

  /** Choose the best candidate index from an array of objects with `.name` */
  function bestNameMatch(query, candidates) {
    const q = (query || "");
    if (!q || !Array.isArray(candidates) || !candidates.length) return 0;
    let bestIdx = 0, bestScore = -Infinity;
    const nq = norm(q);
    candidates.forEach((c, i) => {
      const name = c?.name || "";
      if (!name) return;
      const score = sim(q, name) + (norm(name).startsWith(nq) ? 0.05 : 0); // tiny prefix bonus
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    });
    return bestIdx;
  }

  const normalize = { norm, levPct, jwPct, sim, bestNameMatch };
  window.LookupParts.normalize = normalize;
  window.Lookup.normalize = normalize;
})();
