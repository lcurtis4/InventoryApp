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

async function main() {
  const args = parseArgs(process.argv);
  const raw = await loadRawCards(args.in);
  if (!raw.length) throw new Error('No cards returned from source — refusing to write an empty snapshot.');

  const cards = toCompact(raw);
  const version = utcDateStamp();
  const builtAt = new Date().toISOString();
  const snapshot = {
    schema: 1,
    version,
    builtAt,
    count: cards.length,
    cards,
  };

  const body = JSON.stringify(snapshot);
  const sha256 = createHash('sha256').update(body).digest('hex');
  const snapshotName = `cards-${version}.json`;

  await mkdir(args.out, { recursive: true });
  await writeFile(join(args.out, snapshotName), body, 'utf8');

  const manifest = {
    schema: 1,
    version,
    snapshot: snapshotName,
    count: cards.length,
    builtAt,
    sha256,
  };
  await writeFile(join(args.out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  const sizeMB = (Buffer.byteLength(body) / (1024 * 1024)).toFixed(2);
  const withSets = cards.filter((c) => c.sets.length).length;
  console.log(`[build] wrote ${snapshotName} — ${cards.length} cards (${withSets} with printings), ${sizeMB} MB`);
  console.log(`[build] manifest.json updated — version=${version} sha256=${sha256.slice(0, 12)}…`);
}

main().catch((e) => {
  console.error('[build] FAILED:', e.message);
  process.exit(1);
});
