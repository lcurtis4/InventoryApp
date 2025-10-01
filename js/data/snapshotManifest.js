// js/data/snapshotManifest.js
(function(){
    const CFG = window.APP_CONFIG || {};
    const CHECK_DAYS = Number(CFG.SNAPSHOT_CHECK_DAYS || 3);
    const BASE = CFG.SNAPSHOT_BASE; // e.g., "https://cdn.example.com/ygo-snapshots/"
    const KEY = "namesManifestMeta";

    async function getJson(url, timeoutMs = 5000){
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try { const r = await fetch(url, { signal: ctl.signal, cache: "no-cache" }); return await r.json(); }
    finally { clearTimeout(t); }
    }

    async function ensureChecked(){
    if (!BASE) return null;
    const now = Date.now();
    const meta = JSON.parse(localStorage.getItem(KEY) || "{}");
    const next = (meta.checkedAt || 0) + CHECK_DAYS*24*3600*1000;
    if (now < next && meta.version && meta.snapshotUrl) return meta;

    const manifestUrl = BASE.replace(/\/?$/, "/") + "manifest.json"; // small: {version, snapshot, sha256?}
    const m = await getJson(manifestUrl);
    const snapshotUrl = BASE.replace(/\/?$/, "/") + (m.snapshot || "names.jsonl.gz");

    const out = { checkedAt: now, version: m.version || "", snapshotUrl, sha256: m.sha256 || "" };
    localStorage.setItem(KEY, JSON.stringify(out));
    return out;
    }

    function getCached(){ return JSON.parse(localStorage.getItem(KEY) || "{}"); }

    window.Data = window.Data || {};
    window.Data.snapshotManifest = { ensureChecked, getCached };
})();
