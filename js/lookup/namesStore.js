// js/lookup/namesStore.js — v9.0
// Local cache of every Yu-Gi-Oh card name from YGOPRODeck.
//
// PURPOSE
//   The scanner's name OCR commonly returns a clean read of the title with a
//   trailing junk token from the attribute icon (e.g. "Solemn Accusation E").
//   Instead of round-tripping every guess to the API, we keep an in-memory +
//   localStorage cache of all card names and do a local fuzzy match first.
//   The API is only hit when the local match is below threshold OR when the
//   caller needs full card metadata (sets / rarities / prices).
//
// PUBLIC API (exposed on window.NamesStore)
//   await NamesStore.ready()              → resolves once the store is populated
//   NamesStore.findBest(query, {minScore}) → { name, score } | null
//   NamesStore.size()                     → number of names cached
//   NamesStore.forceRefresh()             → rebuild from API, ignoring TTL
//   NamesStore.lastBuiltAt()              → ms timestamp of the cache
//
// STORAGE
//   localStorage key: "ygo.namesStore.v1"
//   shape: { v: 1, ts: <ms>, names: ["Solemn Accusation", ...] }
//   TTL:   14 days. Beyond TTL we still serve the cache but trigger an async
//          refresh in the background.

(function () {
  'use strict';

  const STORAGE_KEY = 'ygo.namesStore.v1';
  const TTL_MS = 14 * 24 * 60 * 60 * 1000;
  const API_URL = 'https://db.ygoprodeck.com/api/v7/cardinfo.php';

  // CONSOLE-OFF v12 console.log('[namesStore] module loaded — v9.0');

  // ------------------------------------------------------------------
  // Similarity — reuse normalize.js if available, else inline tiny levenshtein
  // ------------------------------------------------------------------
  const N = (window.LookupParts && window.LookupParts.normalize) || {};

  function _normFallback(s) {
    return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }
  function _levPctFallback(a, b) {
    a = _normFallback(a); b = _normFallback(b);
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
    return 1 - dp[m][n] / Math.max(m, n);
  }

  const norm = (typeof N.norm === 'function') ? N.norm : _normFallback;
  const sim  = (typeof N.sim  === 'function') ? N.sim  : _levPctFallback;

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  let _names = [];           // canonical names, original casing
  let _namesLower = [];      // parallel array, normalized — for fast scoring
  let _ts = 0;
  let _readyPromise = null;

  function _loadFromLocalStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.names)) return false;
      _names = parsed.names;
      _namesLower = _names.map((n) => norm(n));
      _ts = Number(parsed.ts || 0);
      // CONSOLE-OFF v12 console.log('[namesStore] loaded from localStorage:', _names.length, 'names, age',
                  // CONSOLE-OFF v12 Math.round((Date.now() - _ts) / (60 * 60 * 1000)), 'h');
      return true;
    } catch (e) {
      // CONSOLE-OFF v12 console.warn('[namesStore] localStorage parse failed:', e);
      return false;
    }
  }

  function _saveToLocalStorage() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, ts: _ts, names: _names }));
      // CONSOLE-OFF v12 console.log('[namesStore] saved to localStorage:', _names.length, 'names');
    } catch (e) {
      // CONSOLE-OFF v12 console.warn('[namesStore] localStorage write failed (quota?):', e);
    }
  }

  async function _fetchAllNames() {
    // CONSOLE-OFF v12 console.log('[namesStore] fetching full card list from YGOPRODeck...');
    const t0 = Date.now();
    // Fetch only what we need. The API ignores misc=no, but we keep payload small
    // by NOT requesting misc data. Each entry is ~name+id; we discard the id.
    const res = await fetch(API_URL);
    if (!res.ok) throw new Error('cardinfo.php HTTP ' + res.status);
    const json = await res.json();
    const list = Array.isArray(json?.data) ? json.data : [];
    const names = [];
    const seen = new Set();
    for (const c of list) {
      const nm = c && c.name;
      if (typeof nm !== 'string' || !nm) continue;
      if (seen.has(nm)) continue;
      seen.add(nm);
      names.push(nm);
    }
    // CONSOLE-OFF v12 console.log('[namesStore] fetched', names.length, 'unique names in',
                // CONSOLE-OFF v12 (Date.now() - t0), 'ms');
    return names;
  }

  async function _rebuild() {
    const names = await _fetchAllNames();
    _names = names;
    _namesLower = _names.map((n) => norm(n));
    _ts = Date.now();
    _saveToLocalStorage();
  }

  // ------------------------------------------------------------------
  // Public: ready() — populate the store, prefer cache.
  // ------------------------------------------------------------------
  function ready() {
    if (_readyPromise) return _readyPromise;

    _readyPromise = (async () => {
      const hadCache = _loadFromLocalStorage();
      const stale = !hadCache || (Date.now() - _ts > TTL_MS);

      if (!hadCache) {
        // No cache → block until we have one
        try {
          await _rebuild();
        } catch (e) {
          // CONSOLE-OFF v12 console.warn('[namesStore] initial fetch failed; running empty:', e);
        }
      } else if (stale) {
        // Have stale cache → serve it immediately, refresh in background
        // CONSOLE-OFF v12 console.log('[namesStore] cache stale, refreshing in background');
        // CONSOLE-OFF v12 _rebuild().catch((e) => console.warn('[namesStore] bg refresh failed:', e));
      }

      return { size: _names.length, ts: _ts };
    })();

    return _readyPromise;
  }

  // ------------------------------------------------------------------
  // Public: findBest(query) — local fuzzy match.
  //
  // Strategy: prefix-bucket scan. Without a heavyweight index, brute-forcing
  // 13k similarities per scan tick is expensive. We:
  //   1. Take the first 3 letters of the cleaned query.
  //   2. Score every name that starts with that prefix (cheap).
  //   3. If best score >= minScore → return.
  //   4. Else widen to all names containing the first 5-letter token.
  //   5. Else fall back to full O(N) — only when steps 2/4 yielded nothing.
  //
  // Returns { name, score } or null.
  // ------------------------------------------------------------------
  function findBest(query, opts) {
    const minScore = (opts && typeof opts.minScore === 'number') ? opts.minScore : 0.85;
    const q = norm(query);
    if (!q || q.length < 3 || _names.length === 0) return null;

    const prefix3 = q.slice(0, 3);
    const firstTok = (q.split(/\s+/)[0] || '').slice(0, 5);

    let bestName = '', bestScore = -Infinity;

    function scan(indexList) {
      for (const i of indexList) {
        const s = sim(q, _namesLower[i]);
        if (s > bestScore) { bestScore = s; bestName = _names[i]; }
      }
    }

    // Pass 1: same 3-letter prefix
    const prefixHits = [];
    for (let i = 0; i < _namesLower.length; i++) {
      if (_namesLower[i].startsWith(prefix3)) prefixHits.push(i);
    }
    scan(prefixHits);

    if (bestScore >= minScore) {
      // CONSOLE-OFF v12 console.log('[namesStore] findBest (prefix):', q, '→', bestName, 'score', bestScore.toFixed(3));
      return { name: bestName, score: bestScore };
    }

    // Pass 2: contains first 5-letter token (catches OCR drift on first char)
    if (firstTok.length >= 4) {
      const containsHits = [];
      for (let i = 0; i < _namesLower.length; i++) {
        if (_namesLower[i].indexOf(firstTok) !== -1) containsHits.push(i);
      }
      scan(containsHits);
      if (bestScore >= minScore) {
        // CONSOLE-OFF v12 console.log('[namesStore] findBest (contains):', q, '→', bestName, 'score', bestScore.toFixed(3));
        return { name: bestName, score: bestScore };
      }
    }

    // Pass 3: full scan (only ~13k strings, ~30ms worst-case)
    const allIdx = [];
    for (let i = 0; i < _namesLower.length; i++) allIdx.push(i);
    scan(allIdx);

    if (bestScore >= minScore) {
      // CONSOLE-OFF v12 console.log('[namesStore] findBest (full):', q, '→', bestName, 'score', bestScore.toFixed(3));
      return { name: bestName, score: bestScore };
    }

    // CONSOLE-OFF v12 console.log('[namesStore] findBest miss:', q, 'best=', bestName, 'score', bestScore.toFixed(3),
                // CONSOLE-OFF v12 '(below', minScore + ')');
    return null;
  }

  function size() { return _names.length; }
  function lastBuiltAt() { return _ts; }
  function forceRefresh() {
    _readyPromise = null;
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
    _names = []; _namesLower = []; _ts = 0;
    return ready();
  }

  window.NamesStore = {
    ready, findBest, size, lastBuiltAt, forceRefresh,
  };
})();
