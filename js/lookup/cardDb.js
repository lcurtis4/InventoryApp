// js/lookup/cardDb.js — DB-1 (#50)
//
// LOCAL CARD DB — source of truth for NAME → printings/sets/rarities lookups.
// Replaces the per-scan live YGOPRODeck call (epic #49). Loads a versioned
// snapshot (built by scripts/build_card_db.mjs) into IndexedDB once, then serves
// all subsequent lookups from the local store — no network per scan.
//
// STORAGE
//   IndexedDB database:  "ygoCardDb"        (chosen over localStorage: the full
//                                            card DB is multiple MB, well past
//                                            localStorage's ~5MB string cap)
//   object store:        "cards"  keyPath="nameLower"
//   meta store:          "meta"   keyPath="k"   (holds { k:"manifest", ... })
//
// SNAPSHOT SOURCE (resolved in order)
//   1. window.APP_CONFIG.CARD_DB_BASE  (remote CDN base; future weekly refresh)
//   2. local "snapshots/" folder shipped with the app  (default / offline-safe)
//
// PUBLIC API (window.CardDb)
//   await CardDb.ready()                  → { count, version, builtAt } | loads if needed
//   await CardDb.lookupByName(name)       → { id, name, sets[] } | null   (exact, case-insensitive)
//   await CardDb.findBest(query,{minScore})→ { id, name, sets[], score } | null (fuzzy)
//   CardDb.version()                      → snapshot version string ("" until ready)
//   CardDb.count()                        → number of cards loaded
//   await CardDb.forceReload()            → wipe + reload from snapshot
//
// DESIGN NOTES
//   • Idempotent load: we store the loaded manifest version in meta; if the
//     shipped/remote snapshot version matches what's already in IndexedDB we
//     skip the (expensive) re-import. #51 will use this to apply weekly diffs.
//   • Fuzzy matching reuses normalize.js if present, else a small Levenshtein.

(function () {
  'use strict';

  const DB_NAME = 'ygoCardDb';
  const DB_VERSION = 1;
  const STORE_CARDS = 'cards';
  const STORE_META = 'meta';
  const META_KEY = 'manifest';

  const CFG = window.APP_CONFIG || {};
  // Where the snapshot + manifest live. Local folder by default; a CDN base can
  // override via APP_CONFIG.CARD_DB_BASE for the weekly-refresh path (#51).
  const BASE = (CFG.CARD_DB_BASE || 'snapshots/').replace(/\/?$/, '/');

  // ---- fuzzy match helpers (reuse normalize.js if available) -----------------
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
  const sim = (typeof N.sim === 'function') ? N.sim : _levPctFallback;

  // ---- IndexedDB plumbing ----------------------------------------------------
  let _dbPromise = null;
  function _openDb() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_CARDS)) {
          db.createObjectStore(STORE_CARDS, { keyPath: 'nameLower' });
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'k' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return _dbPromise;
  }

  function _tx(db, stores, mode) {
    const t = db.transaction(stores, mode);
    return Array.isArray(stores) ? stores.map((s) => t.objectStore(s)) : t.objectStore(stores);
  }
  function _reqAsync(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function _getMeta(db) {
    try { return await _reqAsync(_tx(db, STORE_META, 'readonly').get(META_KEY)); }
    catch { return null; }
  }

  async function _bulkPut(db, cards) {
    // Write in a single transaction; chunk the put() calls to keep the
    // transaction from going idle on very large datasets.
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE_CARDS, 'readwrite');
      const store = t.objectStore(STORE_CARDS);
      t.oncomplete = () => resolve(true);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('tx aborted'));
      store.clear();
      for (const c of cards) {
        store.put({
          nameLower: String(c.name || '').toLowerCase(),
          id: c.id ?? null,
          name: c.name,
          sets: Array.isArray(c.sets) ? c.sets : [],
        });
      }
    });
  }

  async function _setMeta(db, manifest) {
    await _reqAsync(_tx(db, STORE_META, 'readwrite').put({ k: META_KEY, ...manifest }));
  }

  // ---- snapshot fetch --------------------------------------------------------
  async function _getJson(url, timeoutMs = 15000) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } finally {
      clearTimeout(to);
    }
  }

  // ---- in-memory state -------------------------------------------------------
  let _readyPromise = null;
  let _meta = { version: '', builtAt: '', count: 0 };
  // Lightweight in-memory name index for fuzzy scans (names only — cheap).
  let _namesLower = [];
  let _loaded = false;

  async function _loadNameIndex(db) {
    // Pull just the keys for the fuzzy index; values are fetched lazily on hit.
    const keys = await _reqAsync(_tx(db, STORE_CARDS, 'readonly').getAllKeys());
    _namesLower = Array.isArray(keys) ? keys : [];
    _loaded = true;
  }

  async function _importSnapshot(db, manifest) {
    const snapUrl = BASE + (manifest.snapshot || `cards-${manifest.version}.json`);
    const snap = await _getJson(snapUrl);
    const cards = Array.isArray(snap?.cards) ? snap.cards : [];
    if (!cards.length) throw new Error('snapshot contained no cards');
    await _bulkPut(db, cards);
    await _setMeta(db, {
      version: snap.version || manifest.version || '',
      builtAt: snap.builtAt || manifest.builtAt || '',
      count: snap.count || cards.length,
      sha256: manifest.sha256 || '',
    });
    return { version: snap.version, builtAt: snap.builtAt, count: cards.length };
  }

  function ready() {
    if (_readyPromise) return _readyPromise;
    _readyPromise = (async () => {
      const db = await _openDb();

      // What's already stored?
      const stored = await _getMeta(db);

      // What does the (local/remote) manifest say is available?
      let manifest = null;
      try {
        manifest = await _getJson(BASE + 'manifest.json');
      } catch (e) {
        console.warn('[cardDb] manifest fetch failed:', e.message);
      }

      const storedVersion = stored && stored.version;
      const wantVersion = manifest && manifest.version;

      if (storedVersion && (!wantVersion || storedVersion === wantVersion)) {
        // Already current (or no manifest reachable) → serve what we have.
        _meta = { version: stored.version, builtAt: stored.builtAt, count: stored.count };
        await _loadNameIndex(db);
        console.log('[cardDb] ready (cached) —', _meta.count, 'cards, v=' + _meta.version);
        return { ...(_meta) };
      }

      if (wantVersion) {
        // Fresh import (first run) or version changed → import snapshot.
        try {
          const res = await _importSnapshot(db, manifest);
          _meta = { version: res.version, builtAt: res.builtAt, count: res.count };
          await _loadNameIndex(db);
          console.log('[cardDb] ready (imported) —', _meta.count, 'cards, v=' + _meta.version);
          return { ...(_meta) };
        } catch (e) {
          console.warn('[cardDb] import failed:', e.message);
          // Fall through: if we have ANY stored data, keep serving it.
          if (storedVersion) {
            _meta = { version: stored.version, builtAt: stored.builtAt, count: stored.count };
            await _loadNameIndex(db);
            console.log('[cardDb] import failed; serving stale cache v=' + _meta.version);
            return { ...(_meta) };
          }
        }
      }

      // No manifest and no stored data → empty store (lookups return null).
      _loaded = true;
      console.warn('[cardDb] no snapshot available — local DB is empty');
      return { ...(_meta) };
    })();
    return _readyPromise;
  }

  // ---- lookups ---------------------------------------------------------------
  async function lookupByName(name) {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return null;
    const db = await _openDb();
    const rec = await _reqAsync(_tx(db, STORE_CARDS, 'readonly').get(key));
    if (!rec) return null;
    return { id: rec.id, name: rec.name, sets: rec.sets || [] };
  }

  async function findBest(query, opts) {
    const minScore = (opts && typeof opts.minScore === 'number') ? opts.minScore : 0.85;
    const q = norm(query);
    if (!q || q.length < 3) return null;
    if (!_loaded) await ready();
    if (!_namesLower.length) return null;

    // Prefix bucket first (cheap), then widen — same strategy as namesStore.
    const prefix3 = q.slice(0, 3);
    let bestKey = '', bestScore = -Infinity;
    const scan = (idxList) => {
      for (const i of idxList) {
        const s = sim(q, _namesLower[i]);
        if (s > bestScore) { bestScore = s; bestKey = _namesLower[i]; }
      }
    };
    const prefixHits = [];
    for (let i = 0; i < _namesLower.length; i++) {
      if (_namesLower[i].startsWith(prefix3)) prefixHits.push(i);
    }
    scan(prefixHits);
    if (bestScore < minScore) {
      const all = [];
      for (let i = 0; i < _namesLower.length; i++) all.push(i);
      scan(all);
    }
    if (bestScore < minScore || !bestKey) return null;
    const rec = await lookupByName(bestKey);
    return rec ? { ...rec, score: bestScore } : null;
  }

  function version() { return _meta.version || ''; }
  function builtAt() { return _meta.builtAt || ''; }
  function count() { return _meta.count || 0; }

  async function forceReload() {
    _readyPromise = null;
    const db = await _openDb();
    await _reqAsync(_tx(db, STORE_META, 'readwrite').delete(META_KEY));
    await new Promise((resolve, reject) => {
      const t = db.transaction(STORE_CARDS, 'readwrite');
      t.objectStore(STORE_CARDS).clear();
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
    _namesLower = []; _loaded = false;
    _meta = { version: '', builtAt: '', count: 0 };
    return ready();
  }

  window.CardDb = { ready, lookupByName, findBest, version, builtAt, count, forceReload };
})();
