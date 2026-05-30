#!/usr/bin/env node
// scripts/build_card_db.mjs — DB-1 (#50)
//
// Builds a compact, versioned LOCAL CARD DB snapshot from the YGOPRODeck API.
// This snapshot is the source of truth for NAME → printings/sets/rarities
// lookups, replacing the per-scan live API call (epic #49).
//
// Output (written to snapshots/):
//   • cards-<version>.json   — the full snapshot (see SCHEMA below)
//   • manifest.json          — { version, snapshot, count, builtAt, schema, sha256 }
//
// SCHEMA (snapshot file):
//   {
//     "schema": 1,
//     "version": "YYYY-MM-DD-<hash8>",  // UTC build date + first 8 hex of the
//                                       // content hash — content-derived so a
//                                       // same-day refresh with NEW data gets a
//                                       // new version (avoids no-op refresh, #52)
//     "builtAt": "<ISO8601>",
//     "count": <int>,                   // number of card records
//     "cards": [
//       {
//         "id":    <int>,               // YGOPRODeck konami/passcode id
//         "name":  "<string>",          // canonical card name
//         "sets":  [                     // every printing of this card
//           { "set_name": "<string>", "set_code": "<string>", "set_rarity": "<string>" }
//         ]
//       }
//     ]
//   }
//
// NOTE (#50 scope): image refs are intentionally DEFERRED (tracked in #74) to
// keep the snapshot small. Add them there.
//
// Usage:
//   node scripts/build_card_db.mjs                 # fetch live + write snapshot
//   node scripts/build_card_db.mjs --in fixture.json   # build from a local API dump
//   node scripts/build_card_db.mjs --out snapshots     # override output dir
//
// No external dependencies — Node 18+ (global fetch, crypto, fs/promises).

import { writeFile, readFile, mkdir, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const API_URL = 'https://db.ygoprodeck.com/api/v7/cardinfo.php';

function parseArgs(argv) {
  const args = { in: null, out: join(REPO_ROOT, 'snapshots') };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--in') args.in = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadRawCards(inPath) {
  if (inPath) {
    console.log(`[build] reading local API dump: ${inPath}`);
    const txt = await readFile(inPath, 'utf8');
    const json = JSON.parse(txt);
    return Array.isArray(json?.data) ? json.data : (Array.isArray(json) ? json : []);
  }
  console.log(`[build] fetching full card DB from ${API_URL} ...`);
  // Retry with exponential backoff — a single flaky fetch must not fail the
  // weekly refresh (#52). On total failure we throw and main() exits non-zero,
  // which (combined with atomic publish below) leaves the last-good snapshot
  // untouched.
  const MAX_ATTEMPTS = 4;
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(API_URL);
      if (!res.ok) throw new Error(`YGOPRODeck HTTP ${res.status}`);
      const json = await res.json();
      const list = Array.isArray(json?.data) ? json.data : [];
      console.log(`[build] fetched ${list.length} raw cards (attempt ${attempt})`);
      return list;
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_ATTEMPTS) {
        const backoff = 500 * Math.pow(2, attempt - 1); // 500, 1000, 2000 ms
        console.warn(`[build] fetch attempt ${attempt} failed (${e.message}); retrying in ${backoff}ms`);
        await sleep(backoff);
      }
    }
  }
  throw new Error(`YGOPRODeck fetch failed after ${MAX_ATTEMPTS} attempts: ${lastErr && lastErr.message}`);
}

// Transform the verbose API record into our compact local schema.
function toCompact(raw) {
  const cards = [];
  const seen = new Set();
  for (const c of raw) {
    const name = c && typeof c.name === 'string' ? c.name.trim() : '';
    if (!name) continue;
    const id = Number.isFinite(c.id) ? c.id : null;
    // Dedup by name (the DB occasionally lists alt-art rows under same name).
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const sets = [];
    const seenPrint = new Set();
    for (const s of (Array.isArray(c.card_sets) ? c.card_sets : [])) {
      const set_name = (s?.set_name || '').trim();
      const set_code = (s?.set_code || '').trim();
      const set_rarity = (s?.set_rarity || '').trim();
      if (!set_name && !set_code) continue;
      const pk = `${set_name}|${set_code}|${set_rarity}`;
      if (seenPrint.has(pk)) continue;
      seenPrint.add(pk);
      sets.push({ set_name, set_code, set_rarity });
    }
    cards.push({ id, name, sets });
  }
  // Stable sort by name for deterministic diffs (helps #51).
  cards.sort((a, b) => a.name.localeCompare(b.name));
  return cards;
}

function utcDateStamp(d = new Date()) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// Write to a sibling .tmp file then rename() into place. rename() is atomic on
// the same filesystem, so readers never observe a half-written file (#52).
async function writeFileAtomic(path, contents) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, contents, 'utf8');
  await rename(tmp, path);
}

// Content hash of the card payload ONLY (excludes version/builtAt) so we can
// detect "nothing actually changed" runs and skip publishing a new version.
function contentHash(cards) {
  return createHash('sha256').update(JSON.stringify(cards)).digest('hex');
}

// Load the previously-published snapshot via the manifest, if any.
async function loadPrevious(outDir) {
  try {
    const manifest = JSON.parse(await readFile(join(outDir, 'manifest.json'), 'utf8'));
    if (!manifest || !manifest.snapshot) return null;
    const snap = JSON.parse(await readFile(join(outDir, manifest.snapshot), 'utf8'));
    return { manifest, snap };
  } catch {
    return null; // first build / no prior snapshot
  }
}

// Compute a record-level diff between the previous and next card arrays.
// Returns { added:[names], removed:[names], updated:[names], changed:bool }.
// "updated" = same name, but id or printings differ.
function diffCards(prevCards, nextCards) {
  const prev = new Map((prevCards || []).map((c) => [c.name.toLowerCase(), c]));
  const next = new Map((nextCards || []).map((c) => [c.name.toLowerCase(), c]));
  const added = [], removed = [], updated = [];
  const printKey = (c) =>
    (c.sets || []).map((s) => `${s.set_name}|${s.set_code}|${s.set_rarity}`).sort().join('~');

  for (const [k, c] of next) {
    if (!prev.has(k)) { added.push(c.name); continue; }
    const p = prev.get(k);
    if ((p.id ?? null) !== (c.id ?? null) || printKey(p) !== printKey(c)) updated.push(c.name);
  }
  for (const [k, c] of prev) {
    if (!next.has(k)) removed.push(c.name);
  }
  added.sort(); removed.sort(); updated.sort();
  return { added, removed, updated, changed: !!(added.length || removed.length || updated.length) };
}

async function appendChangelog(outDir, version, diff, count) {
  const path = join(outDir, 'CHANGELOG.md');
  let prior = '';
  try { prior = await readFile(path, 'utf8'); } catch {}
  const head = prior ? prior : '# Card DB snapshot changelog\n\n';
  const entry =
    `## ${version}\n` +
    `- Total cards: **${count}**\n` +
    `- Added: **${diff.added.length}**, Updated: **${diff.updated.length}**, Removed: **${diff.removed.length}**\n` +
    (diff.added.length ? `  - New: ${diff.added.slice(0, 25).join(', ')}${diff.added.length > 25 ? ' …' : ''}\n` : '') +
    (diff.updated.length ? `  - Updated: ${diff.updated.slice(0, 25).join(', ')}${diff.updated.length > 25 ? ' …' : ''}\n` : '') +
    (diff.removed.length ? `  - Removed: ${diff.removed.slice(0, 25).join(', ')}${diff.removed.length > 25 ? ' …' : ''}\n` : '') +
    '\n';
  // Insert newest entry just under the title.
  const titleEnd = head.indexOf('\n\n') + 2;
  const out = head.slice(0, titleEnd) + entry + head.slice(titleEnd);
  await writeFile(path, out, 'utf8');
}

async function main() {
  const args = parseArgs(process.argv);
  const raw = await loadRawCards(args.in);
  if (!raw.length) throw new Error('No cards returned from source — refusing to write an empty snapshot.');

  const cards = toCompact(raw);
  const builtAt = new Date().toISOString();

  await mkdir(args.out, { recursive: true });

  // ── Diff vs. the currently-published snapshot ────────────────────────────
  const previous = await loadPrevious(args.out);
  const prevCards = previous?.snap?.cards || [];
  const diff = diffCards(prevCards, cards);
  const nextHash = contentHash(cards);
  const prevHash = prevCards.length ? contentHash(prevCards) : null;

  // Content-derived, monotonic version (#52): date + first 8 hex of the content
  // hash. Same content on the same UTC day ⇒ identical version (correctly
  // skipped as no-change below); changed content on the same day ⇒ a DIFFERENT
  // version, so the client's `storedVersion === wantVersion` short-circuit
  // applies the update instead of silently no-op'ing on a same-day refresh.
  const version = `${utcDateStamp()}-${nextHash.slice(0, 8)}`;

  // No content change → skip publishing a new version (#51: "only changed
  // records are applied"; nothing changed means nothing to apply). The
  // workflow keys its commit step off this exit signal.
  if (prevHash && prevHash === nextHash) {
    console.log(`[build] no card changes since ${previous.manifest.version} — skipping new snapshot.`);
    console.log('::no-changes::'); // machine-readable marker for CI
    return;
  }

  // Content changed ⇒ the version MUST advance. A collision here would resurrect
  // the same-day no-op bug (#52): the client would see an unchanged version and
  // skip the new data. Since the version embeds the content hash this can only
  // happen if the hash collided, but assert it explicitly to fail loudly.
  if (previous?.manifest?.version && version === previous.manifest.version) {
    throw new Error(
      `[build] version collision: content changed but new version "${version}" ` +
      `equals the previously published version. Refusing to publish a ` +
      `self-referential update (would no-op on the client).`
    );
  }

  const snapshot = { schema: 1, version, builtAt, count: cards.length, cards };
  const body = JSON.stringify(snapshot);
  // sha256 is computed over the EXACT bytes written to the snapshot file
  // (`body`). The client (js/lookup/cardDb.js) hashes the raw fetched text of
  // this same file, so the two digests must match byte-for-byte (#52).
  const sha256 = createHash('sha256').update(body).digest('hex');
  const snapshotName = `cards-${version}.json`;

  // Emit a small diff/patch sidecar so the client can apply only changes
  // (#51: "avoid full re-download when incremental update is possible").
  // fromVersion/toVersion carry the content-derived version strings; the
  // collision assertion above guarantees they can never be equal when content
  // changed, so the diff is never self-referential (#52).
  const patch = {
    schema: 1,
    fromVersion: previous?.manifest?.version || null,
    toVersion: version,
    builtAt,
    added: cards.filter((c) => diff.added.includes(c.name)),
    updated: cards.filter((c) => diff.updated.includes(c.name)),
    removed: diff.removed, // names only — client deletes by key
  };
  const patchName = `cards-diff-${version}.json`;
  const patchBody = JSON.stringify(patch);

  const manifest = {
    schema: 1,
    version,
    snapshot: snapshotName,
    count: cards.length,
    builtAt,
    sha256,
    // Incremental-apply hint for the client (#51).
    diff: previous ? { fromVersion: previous.manifest.version, patch: patchName } : null,
  };
  const manifestBody = JSON.stringify(manifest, null, 2) + '\n';

  // ── ATOMIC PUBLISH (#52) ─────────────────────────────────────────────────
  // Write the snapshot and patch to .tmp files, rename() them into place, and
  // write manifest.json LAST. rename() is atomic on the same filesystem, so a
  // crash mid-publish can never leave a partial snapshot referenced by the
  // manifest — readers either see the old, fully-consistent set of files or
  // the new one. Because the manifest (which carries the version + sha256 the
  // client keys off) lands last, the last-good DB is never corrupted.
  await writeFileAtomic(join(args.out, snapshotName), body);
  await writeFileAtomic(join(args.out, patchName), patchBody);
  await writeFileAtomic(join(args.out, 'manifest.json'), manifestBody);

  await appendChangelog(args.out, version, diff, cards.length);

  const sizeMB = (Buffer.byteLength(body) / (1024 * 1024)).toFixed(2);
  const withSets = cards.filter((c) => c.sets.length).length;
  console.log(`[build] wrote ${snapshotName} — ${cards.length} cards (${withSets} with printings), ${sizeMB} MB`);
  console.log(`[build] diff vs ${previous?.manifest?.version || '(none)'}: +${diff.added.length} added, ~${diff.updated.length} updated, -${diff.removed.length} removed → ${patchName}`);
  console.log(`[build] manifest.json updated — version=${version} sha256=${sha256.slice(0, 12)}…`);
  console.log('::changed::'); // machine-readable marker for CI
}

main().catch((e) => {
  console.error('[build] FAILED:', e.message);
  process.exit(1);
});
