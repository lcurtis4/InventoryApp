// server/imageRecognition/similarity.mjs — spike (#56)
//
// Art-similarity scoring for the server-side visual recognition spike.
//
// METHOD: average hash (aHash) + Hamming distance.
//   1. Decode image → RGBA.
//   2. Box-downsample to HASH_SIZE×HASH_SIZE grayscale (default 8×8 = 64 bits).
//   3. Threshold each cell against the frame's mean luma → 1 bit per cell.
//   4. Similarity = 1 − (Hamming distance / bitCount), in [0,1].
//
// WHY aHash (not raw Pearson on pixels):
//   • Robust to the JPEG recompression, rescaling and mild colour shifts that
//     differ between a phone camera crop and YGOPRODeck's official scan — we
//     compare structure, not exact pixel values.
//   • Fixed-length, cheap to compute and compare (a 64-bit fingerprint), so the
//     server can score a dozen candidates in milliseconds.
//   • Deterministic and trivially testable (the threshold step is pure).
//   The original browser code used Pearson on 32×32 grayscale; aHash is a
//   strict improvement for cross-source matching and is the standard perceptual
//   hash for this job. Pearson is kept available below for comparison/testing.

import { decodeImage } from './vendor/decodeImage.mjs';

export const HASH_SIZE = 8; // 8×8 → 64-bit hash

// Box-downsample RGBA → size×size Float32 grayscale (0..255).
export function toGrayDownsampled(img, size = HASH_SIZE) {
  const { width: W, height: H, data } = img;
  const out = new Float32Array(size * size);
  for (let gy = 0; gy < size; gy++) {
    const y0 = Math.floor((gy * H) / size);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * H) / size));
    for (let gx = 0; gx < size; gx++) {
      const x0 = Math.floor((gx * W) / size);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * W) / size));
      let sum = 0, cnt = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * W + x) * 4;
          sum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
          cnt++;
        }
      }
      out[gy * size + gx] = cnt ? sum / cnt : 0;
    }
  }
  return out;
}

// Average-hash: returns a Uint8Array of size*size bits (0/1).
export function averageHash(img, size = HASH_SIZE) {
  const gray = toGrayDownsampled(img, size);
  let mean = 0;
  for (let i = 0; i < gray.length; i++) mean += gray[i];
  mean /= gray.length;
  const bits = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) bits[i] = gray[i] >= mean ? 1 : 0;
  return bits;
}

// Hamming distance between two equal-length bit arrays.
export function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

// aHash similarity in [0,1]; 1 = identical fingerprint.
export function hashSimilarity(imgA, imgB, size = HASH_SIZE) {
  const ha = averageHash(imgA, size);
  const hb = averageHash(imgB, size);
  return 1 - hamming(ha, hb) / ha.length;
}

// Pearson correlation on downsampled grayscale, normalized to [0,1].
// Retained for parity with the original browser approach / for tests.
export function pearsonSimilarity(imgA, imgB, size = 16) {
  const a = toGrayDownsampled(imgA, size);
  const b = toGrayDownsampled(imgB, size);
  const n = a.length;
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  const den = Math.sqrt(da * db);
  if (den < 1e-9) return 0;
  return Math.max(0, Math.min(1, (num / den + 1) / 2));
}

// Convenience: similarity directly from two encoded image buffers.
export function similarityFromBuffers(bufA, bufB, method = 'ahash') {
  const a = decodeImage(bufA);
  const b = decodeImage(bufB);
  return method === 'pearson' ? pearsonSimilarity(a, b) : hashSimilarity(a, b);
}
