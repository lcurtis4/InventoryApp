// scripts/test/build_card_db.test.mjs — DB-3 (#52)
//
// Run: node --test scripts/test/
//
// Proves the content-derived version scheme fixes the same-day no-op refresh
// bug (PR #76 review): two builds on the SAME UTC day must produce the SAME
// version when content is identical (so the no-change path is taken), and a
// DIFFERENT version when content changed (so the client applies the update and
// the diff sidecar is never self-referential).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const BUILD = join(dirname(fileURLToPath(import.meta.url)), '..', 'build_card_db.mjs');

// Minimal API-shaped fixture ({ data: [ { id, name, card_sets } ] }).
function apiDump(cards) {
  return JSON.stringify({ data: cards });
}
const card = (id, name, sets = []) => ({
  id,
  name,
  card_sets: sets.map((s) => ({ set_name: s[0], set_code: s[1], set_rarity: s[2] })),
});

async function build(outDir, dump) {
  const inPath = join(outDir, `in-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(inPath, dump, 'utf8');
  const { stdout } = await execFileP('node', [BUILD, '--in', inPath, '--out', outDir]);
  return stdout;
}

async function readManifest(outDir) {
  return JSON.parse(await readFile(join(outDir, 'manifest.json'), 'utf8'));
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/;

test('version is date + 8-hex content hash', async () => {
  const out = await mkdtemp(join(tmpdir(), 'carddb-'));
  await build(out, apiDump([card(1, 'Alpha', [['Set A', 'AA-001', 'Common']])]));
  const m = await readManifest(out);
  assert.match(m.version, DATE_RE, `version "${m.version}" should be YYYY-MM-DD-<hash8>`);
  assert.equal(m.snapshot, `cards-${m.version}.json`);
});

test('same content, same day → identical version → no-change path (no spurious diff)', async () => {
  const out = await mkdtemp(join(tmpdir(), 'carddb-'));
  const dump = apiDump([
    card(1, 'Alpha', [['Set A', 'AA-001', 'Common']]),
    card(2, 'Beta', [['Set B', 'BB-002', 'Rare']]),
  ]);

  const out1 = await build(out, dump);
  assert.match(out1, /::changed::/, 'first build should publish');
  const v1 = (await readManifest(out)).version;
  const diffsAfter1 = (await readdir(out)).filter((f) => f.startsWith('cards-diff-'));

  // Second build, same UTC day, IDENTICAL content.
  const out2 = await build(out, dump);
  assert.match(out2, /::no-changes::/, 'second identical build must take the no-change path');

  // Version unchanged, and the second build emitted NO new diff sidecar.
  const v2 = (await readManifest(out)).version;
  assert.equal(v2, v1, 'identical content on the same day must yield the SAME version');
  const diffsAfter2 = (await readdir(out)).filter((f) => f.startsWith('cards-diff-'));
  assert.deepEqual(diffsAfter2, diffsAfter1,
    'no new diff sidecar should be produced when nothing changed');
});

test('changed content, same day → different version → real, non-self-referential diff', async () => {
  const out = await mkdtemp(join(tmpdir(), 'carddb-'));
  const v0dump = apiDump([card(1, 'Alpha', [['Set A', 'AA-001', 'Common']])]);
  await build(out, v0dump);
  const m0 = await readManifest(out);

  // Second build, SAME UTC day, CHANGED content (a card added).
  const v1dump = apiDump([
    card(1, 'Alpha', [['Set A', 'AA-001', 'Common']]),
    card(2, 'Beta', [['Set B', 'BB-002', 'Rare']]),
  ]);
  const out1 = await build(out, v1dump);
  assert.match(out1, /::changed::/, 'changed content must publish a new snapshot');
  const m1 = await readManifest(out);

  // Same day → same date prefix, but DIFFERENT version (hash suffix differs).
  assert.equal(m0.version.slice(0, 10), m1.version.slice(0, 10), 'same UTC day expected');
  assert.notEqual(m1.version, m0.version,
    'changed content on the same day MUST advance the version');

  // The diff sidecar must reference both versions and never be self-referential.
  const patch = JSON.parse(await readFile(join(out, `cards-diff-${m1.version}.json`), 'utf8'));
  assert.equal(patch.fromVersion, m0.version);
  assert.equal(patch.toVersion, m1.version);
  assert.notEqual(patch.fromVersion, patch.toVersion,
    'diff must not be self-referential (fromVersion !== toVersion)');
  assert.deepEqual(patch.added.map((c) => c.name), ['Beta']);

  // Manifest diff hint points client from the old version to the patch.
  assert.equal(m1.diff.fromVersion, m0.version);
  assert.equal(m1.diff.patch, `cards-diff-${m1.version}.json`);

  // Snapshot files coexist (new name didn't overwrite the old one).
  const files = await readdir(out);
  assert.ok(files.includes(`cards-${m0.version}.json`), 'old snapshot kept');
  assert.ok(files.includes(`cards-${m1.version}.json`), 'new snapshot written under new name');
});

test('manifest.sha256 matches the snapshot bytes exactly', async () => {
  const out = await mkdtemp(join(tmpdir(), 'carddb-'));
  await build(out, apiDump([card(1, 'Alpha', [['Set A', 'AA-001', 'Common']])]));
  const m = await readManifest(out);
  const { createHash } = await import('node:crypto');
  const bytes = await readFile(join(out, m.snapshot));
  const sha = createHash('sha256').update(bytes).digest('hex');
  assert.equal(sha, m.sha256, 'manifest.sha256 must equal sha256 of the snapshot file');
});
