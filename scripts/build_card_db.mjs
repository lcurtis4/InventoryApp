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
//     "version": "YYYY-MM-DD",          // build date (UTC), source of truth for freshness
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

import { writeFile, readFile, mkdir } from 'node:fs/promises';
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

async function loadRawCards(inPath) {
  if (inPath) {
    console.log(`[build] reading local API dump: ${inPath}`);
    const txt = await readFile(inPath, 'utf8');
    const json = JSON.parse(txt);
    return Array.isArray(json?.data) ? json.data : (Array.isArray(json) ? json : []);
  }
  console.log(`[build] fetching full card DB from ${API_URL} ...`);
  const res = await fetch(API_URL);
  if (!res.ok) throw new Error(`YGOPRODeck HTTP ${res.status}`);
  const json = await res.json();
  const list = Array.isArray(json?.data) ? json.data : [];
  console.log(`[build] fetched ${list.length} raw cards`);
  return list;
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
  const version = utcDateStamp();
  const builtAt = new Date().toISOString();

  await mkdir(args.out, { recursive: true });

  // ── Diff vs. the currently-published snapshot ────────────────────────────
  const previous = await loadPrevious(args.out);
  const prevCards = previous?.snap?.cards || [];
  const diff = diffCards(prevCards, cards);
  const nextHash = contentHash(cards);
  const prevHash = prevCards.length ? contentHash(prevCards) : null;

  // No content change → skip publishing a new version (#51: "only changed
  // records are applied"; nothing changed means nothing to apply). The
  // workflow keys its commit step off this exit signal.
  if (prevHash && prevHash === nextHash) {
    console.log(`[build] no card changes since ${previous.manifest.version} — skipping new snapshot.`);
    console.log('::no-changes::'); // machine-readable marker for CI
    return;
  }

  const snapshot = { schema: 1, version, builtAt, count: cards.length, cards };
  const body = JSON.stringify(snapshot);
  const sha256 = createHash('sha256').update(body).digest('hex');
  const snapshotName = `cards-${version}.json`;
  await writeFile(join(args.out, snapshotName), body, 'utf8');

  // Emit a small diff/patch sidecar so the client can apply only changes
  // (#51: "avoid full re-download when incremental update is possible").
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
  await writeFile(join(args.out, patchName), JSON.stringify(patch), 'utf8');

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
  await writeFile(join(args.out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

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
