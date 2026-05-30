// server/imageRecognition/score.mjs — spike (#56)
//
// Core scoring logic, decoupled from the HTTP layer so it is directly unit
// testable. Given the camera art crop and a candidate list (each with an
// `imageUrl` to the official art), fetch every candidate's art server-side
// (no browser CORS limits), compute an aHash similarity vs the crop, and blend
// it with the candidate's existing text/OCR score.
//
// blendedScore = TEXT_WEIGHT * textScore + VIS_WEIGHT * imgScore
// (weights mirror the browser defaults: 0.70 text / 0.30 visual.)

import { decodeImage, bufferFromDataUrl } from './vendor/decodeImage.mjs';
import { averageHash, hamming, HASH_SIZE } from './similarity.mjs';

export const VIS_WEIGHT = 0.30;
export const TEXT_WEIGHT = 0.70;

const FETCH_TIMEOUT_MS = 4000;

// Fetch a candidate art image and return its decoded RGBA, or null on any error.
// `fetchImpl` is injectable so tests can supply local fixtures with no network.
async function fetchArt(url, fetchImpl) {
  if (!url) return null;
  const f = fetchImpl || globalThis.fetch;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await f(url, { signal: ac.signal });
    if (!res || !res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return decodeImage(buf);
  } catch {
    return null; // network/CORS-free server-side, but be defensive anyway
  } finally {
    clearTimeout(t);
  }
}

function clamp01(n) { return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0)); }

/**
 * scoreCandidates — the heart of the spike.
 *
 * @param {string} artDataUrl   data: URL of the camera art crop
 * @param {Array}  candidates   [{ name, id, imageUrl, score, ... }]
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl]  override fetch (for tests/fixtures)
 * @returns {Promise<Array>} candidates annotated with imgScore + blendedScore,
 *                           sorted by blendedScore desc.
 */
export async function scoreCandidates(artDataUrl, candidates, opts = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!artDataUrl || !list.length) {
    return list
      .map(c => ({ ...c, imgScore: null, blendedScore: clamp01(c.score) }))
      .sort((a, b) => b.blendedScore - a.blendedScore);
  }

  const cropImg = decodeImage(bufferFromDataUrl(artDataUrl));
  const cropHash = averageHash(cropImg, HASH_SIZE);

  const scored = await Promise.all(list.map(async (c) => {
    const art = await fetchArt(c.imageUrl, opts.fetchImpl);
    if (!art) {
      // Could not get/decode this candidate's art → no visual signal for it.
      return { ...c, imgScore: null, blendedScore: clamp01(c.score) };
    }
    const h = averageHash(art, HASH_SIZE);
    const imgScore = 1 - hamming(cropHash, h) / cropHash.length;
    const textScore = clamp01(c.score);
    const blendedScore = TEXT_WEIGHT * textScore + VIS_WEIGHT * imgScore;
    return { ...c, imgScore, blendedScore: clamp01(blendedScore) };
  }));

  return scored.sort((a, b) => b.blendedScore - a.blendedScore);
}
