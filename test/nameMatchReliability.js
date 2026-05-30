#!/usr/bin/env node
/*
 * Sprint 6 / Epic #63 gate harness — name-match reliability (Option B).
 *
 * Tests the REAL production matcher (js/lookup/normalize.js + js/lookup/namesStore.js)
 * against a labeled sample of realistic OCR title reads. This isolates the
 * name-matching accuracy from camera/OCR-image quality: given the kind of text
 * the title OCR actually emits (clean reads, trailing attribute-icon junk,
 * single-char drift, glare drops), does the local DB resolve the correct card?
 *
 * Reliability = correct top-matches / total samples, at the production
 * findBest threshold (minScore: 0.85). This number is the explicit gate input
 * for #54 (set-code OCR removal).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const API_URL = 'https://db.ygoprodeck.com/api/v7/cardinfo.php';
const MIN_SCORE = 0.85; // production default in findBest()

// ---- Labeled sample -------------------------------------------------------
// Each: { ocr: <what the title OCR emitted>, expect: <canonical card name> }
// Mix of: clean reads, trailing attribute/level icon junk, single-char drift,
// missing/extra chars, casing, and a couple of deliberately-degenerate reads.
const SAMPLES = [
  // clean reads
  { ocr: 'Dark Magician', expect: 'Dark Magician' },
  { ocr: 'Blue-Eyes White Dragon', expect: 'Blue-Eyes White Dragon' },
  { ocr: 'Pot of Greed', expect: 'Pot of Greed' },
  { ocr: 'Mystical Space Typhoon', expect: 'Mystical Space Typhoon' },
  { ocr: 'Monster Reborn', expect: 'Monster Reborn' },
  { ocr: 'Raigeki', expect: 'Raigeki' },
  { ocr: 'Mirror Force', expect: 'Mirror Force' },
  { ocr: 'Solemn Judgment', expect: 'Solemn Judgment' },
  { ocr: 'Elemental HERO Sparkman', expect: 'Elemental HERO Sparkman' },
  { ocr: 'Polymerization', expect: 'Polymerization' },
  // trailing attribute / level / icon junk (the common OCR failure mode)
  { ocr: 'Solemn Accusation E', expect: 'Solemn Accusation' },
  { ocr: 'Dark Magician &', expect: 'Dark Magician' },
  { ocr: 'Pot of Greed 68', expect: 'Pot of Greed' },
  { ocr: 'Mystical Space Typhoon -e', expect: 'Mystical Space Typhoon' },
  { ocr: 'Mirror Force ee', expect: 'Mirror Force' },
  { ocr: 'Raigeki 3', expect: 'Raigeki' },
  { ocr: 'Monster Reborn |', expect: 'Monster Reborn' },
  // single-character OCR drift (rn->m, l->1, O->0, etc.)
  { ocr: 'Dark Maglcian', expect: 'Dark Magician' },
  { ocr: 'Blue-Eyes Whlte Dragon', expect: 'Blue-Eyes White Dragon' },
  { ocr: 'Polymerlzation', expect: 'Polymerization' },
  { ocr: 'M0nster Reborn', expect: 'Monster Reborn' },
  { ocr: 'Soiemn Judgment', expect: 'Solemn Judgment' },
  // dropped/space-mangled chars from glare
  { ocr: 'MysticalSpace Typhoon', expect: 'Mystical Space Typhoon' },
  { ocr: 'Mirror Forc', expect: 'Mirror Force' },
  { ocr: 'Elemental HERO Spakman', expect: 'Elemental HERO Sparkman' },
  // casing-only
  { ocr: 'POT OF GREED', expect: 'Pot of Greed' },
  { ocr: 'raigeki', expect: 'Raigeki' },
  // harder longer titles
  { ocr: 'Black Luster Soldier - Envoy of the Beginning', expect: 'Black Luster Soldier - Envoy of the Beginning' },
  { ocr: 'Black Luster Soldier Envoy of the Beginning E', expect: 'Black Luster Soldier - Envoy of the Beginning' },
  { ocr: 'Cyber Dragon', expect: 'Cyber Dragon' },
];

// ---- Minimal browser shim so we can load the REAL modules unmodified ------
function makeContext() {
  const store = {};
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const sandbox = {
    window: {},
    localStorage,
    console: { log() {}, warn() {}, error() {} }, // silence module chatter
    fetch: global.fetch, // Node 18+ has global fetch
    Date,
    Math,
    JSON,
    setTimeout,
    clearTimeout,
    AbortController,
  };
  sandbox.window.localStorage = localStorage;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}

function loadModule(ctx, relPath) {
  const code = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  vm.runInContext(code, ctx, { filename: relPath });
}

async function main() {
  const ctx = makeContext();
  // Load the real production modules into the shared window
  loadModule(ctx, 'js/lookup/normalize.js');
  loadModule(ctx, 'js/lookup/namesStore.js');

  const NamesStore = ctx.window.NamesStore;
  if (!NamesStore) throw new Error('NamesStore failed to load');

  // Populate the store from the SAME source the app uses.
  process.stdout.write('Fetching full card-name list from YGOPRODeck... ');
  const info = await NamesStore.ready();
  console.log(`done — ${NamesStore.size()} names cached.`);
  if (NamesStore.size() === 0) {
    console.error('ERROR: names store is empty (network/API issue). Cannot measure.');
    process.exit(2);
  }

  // Run the labeled sample through the REAL findBest at the production threshold.
  let correct = 0;
  const rows = [];
  for (const s of SAMPLES) {
    const hit = NamesStore.findBest(s.ocr, { minScore: MIN_SCORE });
    const got = hit ? hit.name : null;
    const score = hit ? hit.score : 0;
    const ok = got === s.expect;
    if (ok) correct++;
    rows.push({ ocr: s.ocr, expect: s.expect, got: got || '(no match)', score: score.toFixed(3), ok });
  }

  const total = SAMPLES.length;
  const pct = (correct / total) * 100;

  console.log('\nOCR string                                       | expected -> got                                  | score | result');
  console.log('-'.repeat(140));
  for (const r of rows) {
    console.log(
      `${r.ocr.padEnd(48)} | ${(r.expect + ' -> ' + r.got).padEnd(64)} | ${r.score} | ${r.ok ? 'PASS' : 'FAIL'}`
    );
  }
  console.log('-'.repeat(140));
  console.log(`\nNAME-MATCH RELIABILITY: ${correct}/${total} = ${pct.toFixed(1)}%  (threshold minScore=${MIN_SCORE}, DB=${NamesStore.size()} names)`);

  // Emit a machine-readable summary line + JSON file for the #49 comment.
  const summary = { correct, total, pct: Number(pct.toFixed(1)), minScore: MIN_SCORE, dbSize: NamesStore.size(), failures: rows.filter(r => !r.ok) };
  fs.writeFileSync(path.join(ROOT, 'test', 'nameMatchReliability.result.json'), JSON.stringify(summary, null, 2));
  console.log('RESULT_JSON ' + JSON.stringify(summary));
}

main().catch((e) => { console.error('HARNESS ERROR:', e && e.message || e); process.exit(1); });
