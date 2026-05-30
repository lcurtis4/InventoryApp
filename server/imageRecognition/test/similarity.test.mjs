// server/imageRecognition/test/similarity.test.mjs — spike (#56)
//
// Run: node --test server/imageRecognition/test/
//
// Proves: (1) the aHash similarity ranks near-identical art above similar-art
// twins above distinct art, and (2) the blended score flips an ambiguous
// text-only ranking onto the visually correct candidate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { decodeImage } from '../vendor/decodeImage.mjs';
import { hashSimilarity, pearsonSimilarity } from '../similarity.mjs';
import { scoreCandidates } from '../score.mjs';
import { buildFixtures } from './makeFixtures.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = async (f) => decodeImage(await readFile(join(FIX, f)));
const bytes = (f) => readFile(join(FIX, f));

test('fixtures build', async () => {
  const names = await buildFixtures();
  assert.ok(names.includes('crop.png'));
});

test('aHash ranks true match > similar twin > distinct art', async () => {
  const [crop, A, B, C] = await Promise.all(
    ['crop.png', 'cardA.png', 'cardB.png', 'cardC.png'].map(load));
  const sA = hashSimilarity(crop, A);
  const sB = hashSimilarity(crop, B);
  const sC = hashSimilarity(crop, C);
  assert.ok(sA > sB, `expected A(${sA}) > B(${sB})`);
  assert.ok(sB > sC, `expected B(${sB}) > C(${sC})`);
  assert.equal(sA, 1, 'noisy crop of A should hash-match A exactly at 8x8');
});

test('distinct images score lower than near-identical images', async () => {
  const [A, B, C] = await Promise.all(['cardA.png', 'cardB.png', 'cardC.png'].map(load));
  assert.ok(hashSimilarity(A, A) === 1);
  assert.ok(hashSimilarity(A, C) < hashSimilarity(A, B),
    'A↔C (distinct) must be less similar than A↔B (twin palette)');
});

test('pearson similarity agrees on ordering (sanity)', async () => {
  const [crop, A, C] = await Promise.all(['crop.png', 'cardA.png', 'cardC.png'].map(load));
  assert.ok(pearsonSimilarity(crop, A) > pearsonSimilarity(crop, C));
});

// A local fetch stub that serves fixture files by their imageUrl path.
function fixtureFetch() {
  return async (url) => {
    const name = String(url).split('/').pop();
    try {
      const buf = await bytes(name);
      return { ok: true, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
    } catch {
      return { ok: false };
    }
  };
}

test('blendedScore flips an ambiguous text-only ranking to the visual winner', async () => {
  const cropDataUrl = 'data:image/png;base64,' + (await bytes('crop.png')).toString('base64');

  // Text/OCR is AMBIGUOUS: the wrong twin (B) is marginally ahead on text.
  const candidates = [
    { name: 'Card B (twin art)',   id: 2, imageUrl: 'http://x/cardB.png', score: 0.82 },
    { name: 'Card A (true match)', id: 1, imageUrl: 'http://x/cardA.png', score: 0.80 },
    { name: 'Card C (distinct)',   id: 3, imageUrl: 'http://x/cardC.png', score: 0.78 },
  ];

  // Text-only winner would be B.
  const textWinner = [...candidates].sort((a, b) => b.score - a.score)[0];
  assert.equal(textWinner.id, 2);

  const scored = await scoreCandidates(cropDataUrl, candidates, { fetchImpl: fixtureFetch() });

  // Visual blend must promote A to the top.
  assert.equal(scored[0].id, 1, 'blended winner should be the true visual match A');
  assert.ok(scored[0].imgScore > scored[1].imgScore);
  for (const c of scored) {
    assert.ok(typeof c.blendedScore === 'number');
    assert.ok(c.blendedScore >= 0 && c.blendedScore <= 1);
  }
});

test('candidates whose art fails to fetch fall back to text-only score', async () => {
  const cropDataUrl = 'data:image/png;base64,' + (await bytes('crop.png')).toString('base64');
  const candidates = [
    { name: 'Unreachable art', id: 9, imageUrl: 'http://x/does-not-exist.png', score: 0.5 },
  ];
  const scored = await scoreCandidates(cropDataUrl, candidates, { fetchImpl: fixtureFetch() });
  assert.equal(scored[0].imgScore, null);
  assert.equal(scored[0].blendedScore, 0.5);
});

test('empty input is handled without throwing', async () => {
  assert.deepEqual(await scoreCandidates('', []), []);
  const out = await scoreCandidates('', [{ name: 'x', score: 0.3 }]);
  assert.equal(out[0].blendedScore, 0.3);
});
