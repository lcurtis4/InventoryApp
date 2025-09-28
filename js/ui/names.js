// js/ui/names.js
(function(){
  window.UI = window.UI || {};

  function _norm(s){
    if (!s) return "";
    let t = s;
    t = t.replace(/[“”"‘’`]/g, "'")
      .replace(/[|_•·]/g, "-")
      .replace(/[^\w\s\-\&\!\?:,\.']/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    t = t.replace(/\s*-\s*/g, "-");
    return t;
  }

  function levenshteinPercent(a, b){
    a = _norm(a); b = _norm(b);
    if (!a || !b) return 0;
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++){
      for (let j = 1; j <= n; j++){
        const c = a[i-1] === b[j-1] ? 0 : 1;
        dp[i][j] = Math.min(dp[i-1][j] + 1, dp[i][j-1] + 1, dp[i-1][j-1] + c);
      }
    }
    const d = dp[m][n];
    return Math.round(100 * (1 - d / Math.max(m, n)));
  }

  function jaroWinklerPercent(s1, s2){
    const m = Math; s1 = _norm(s1); s2 = _norm(s2);
    if (!s1 || !s2) return 0;
    const matchDist = m.floor(m.max(s1.length, s2.length) / 2) - 1;
    const aM = new Array(s1.length), bM = new Array(s2.length);
    let matches = 0, trans = 0;
    for (let i = 0; i < s1.length; i++){
      const start = m.max(0, i - matchDist), end = m.min(i + matchDist + 1, s2.length);
      for (let k = start; k < end; k++){
        if (bM[k]) continue;
        if (s1[i] !== s2[k]) continue;
        aM[i] = bM[k] = true; matches++; break;
      }
    }
    if (matches === 0) return 0;
    let k = 0;
    for (let i = 0; i < s1.length; i++){
      if (!aM[i]) continue;
      while (!bM[k]) k++;
      if (s1[i] !== s2[k]) trans++;
      k++;
    }
    const jaro = ((matches / s1.length) + (matches / s2.length) + ((matches - trans / 2) / matches)) / 3;
    let prefix = 0; for (let i = 0; i < m.min(4, s1.length, s2.length); i++){ if (s1[i] === s2[i]) prefix++; else break; }
    const jw = jaro + prefix * 0.1 * (1 - jaro);
    return m.round(jw * 100);
  }

  function computeAccuracy(ocr, canon){
    const a = _norm(ocr), b = _norm(canon);
    if (!a || !b) return 0;
    if (a.includes(b) || b.includes(a)) return 100;
    return Math.max(levenshteinPercent(a, b), jaroWinklerPercent(a, b));
  }

  window.UI.names = { computeAccuracy };
})();