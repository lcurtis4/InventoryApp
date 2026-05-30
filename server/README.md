# Server-side visual card recognition — SPIKE (#56)

> **Status: SPIKE / proof-of-concept.** This is a self-contained prototype that
> proves out the `ImageAssist.backendHook` extension point. It is **not** the
> full backend migration (#13) and is **disabled by default** — production
> behavior is unchanged unless a backend URL is configured.

## Why this exists

In #27 (console hygiene) the browser-only visual art scoring in
`js/scanner/imageAssist.js` was **disabled**. It read YGOPRODeck thumbnail
pixels via `canvas.getImageData()` to compute a Pearson art-similarity score,
but `images.ygoprodeck.com` sends **no `Access-Control-Allow-Origin` header**,
so every cross-origin pixel read failed with `net::ERR_FAILED` (a corsproxy.io
workaround made it worse with 403s). Card matching was reduced to text/OCR
score only.

This spike restores visual art-matching by moving the cross-origin image fetch
**server-side**, where CORS does not apply. The browser never reads cross-origin
pixels again — it only POSTs its own art crop (a `data:` URL) as JSON.

## What it does

```
  browser (scanner)                       backend (this service)
  ─────────────────                       ──────────────────────
  1. crop card art from camera frame
  2. POST { artDataUrl, candidates } ───▶ 3. for each candidate:
                                             - fetch official art (no CORS)
                                             - aHash both, Hamming distance
                                             - imgScore = 1 - dist/64
                                             - blendedScore = 0.7*text + 0.3*img
  5. reorder by blendedScore        ◀───  4. return candidates + scores (sorted)
```

If the backend is unreachable / errors / times out, the client **silently
falls back** to the existing text-only score. No thrown errors, no console spam.

## Files

| File | Purpose |
|------|---------|
| `imageRecognition/server.mjs` | Standalone HTTP service (`GET /health`, `POST /score`). Zero deps. |
| `imageRecognition/score.mjs` | `scoreCandidates(artDataUrl, candidates)` — fetch art + blend scores. Testable, HTTP-free. |
| `imageRecognition/similarity.mjs` | aHash + Hamming (and a Pearson fallback) similarity. |
| `imageRecognition/vendor/decodeImage.mjs` | Sniff + decode JPEG/PNG → RGBA. |
| `imageRecognition/vendor/pngDecode.mjs` | Dependency-free PNG decoder (Node `zlib`). |
| `imageRecognition/vendor/jpegDecode.cjs` | Vendored baseline JPEG decoder (jpeg-js; see `jpeg-js-LICENSE.txt`). |
| `imageRecognition/test/` | Node-test unit/integration tests, Playwright client test, fixture generator. |

Client wiring lives in `js/scanner/imageAssist.js` (`makeBackendHook`) and the
config flag in `config.js` (`IMAGE_RECOGNITION_URL`).

## Run the backend

No npm install required — Node 18+ (uses global `fetch`, `node:http`, `node:zlib`).

```bash
node server/imageRecognition/server.mjs            # listens on 127.0.0.1:8787
PORT=9000 node server/imageRecognition/server.mjs  # custom port
curl http://127.0.0.1:8787/health                  # {"ok":true,...}
```

## Enable it in the client

In `config.js`, set the endpoint (default is empty = disabled):

```js
IMAGE_RECOGNITION_URL: "http://127.0.0.1:8787/score"
```

Or wire it live from DevTools without editing config:

```js
window.ImageAssist.backendHook = window.ImageAssist.makeBackendHook("http://127.0.0.1:8787/score");
```

When `IMAGE_RECOGNITION_URL` is empty, `ImageAssist.backendHook` stays `null` and
the scanner uses the text-only path exactly as before.

## Endpoint contract

`POST /score`

```jsonc
// request
{
  "artDataUrl": "data:image/jpeg;base64,...",   // the camera art crop
  "candidates": [
    { "name": "...", "id": 12345, "imageUrl": "https://images.ygoprodeck.com/images/cards_small/12345.jpg", "score": 0.80 }
  ]
}
// response
{
  "candidates": [   // sorted by blendedScore desc
    { "name": "...", "id": 12345, "imageUrl": "...", "score": 0.80,
      "imgScore": 1.0, "blendedScore": 0.86 }
  ]
}
```

This matches the documented `backendHook` signature:
`async (artCropDataURL, candidates) => scoredCandidates[]`, where each result
carries `imgScore` (0–1) and `blendedScore`.

## Scoring method: average hash (aHash) + Hamming distance

Each image is decoded, box-downsampled to **8×8 grayscale (64 cells)**, and each
cell is thresholded against the frame mean → a **64-bit perceptual fingerprint**.
Similarity = `1 − HammingDistance / 64`, in `[0,1]`.

**Why aHash over raw Pearson-on-pixels** (the original browser approach):

- **Robust to source mismatch.** A phone camera crop and YGOPRODeck's official
  scan differ in JPEG compression, scale, and mild color/lighting. aHash
  compares coarse *structure*, not exact pixel values, so it tolerates that.
- **Cheap & fixed-length.** A 64-bit fingerprint compares in nanoseconds, so the
  server scores a dozen candidates in milliseconds.
- **Deterministic & testable.** The threshold step is pure, making the
  disambiguation behavior easy to assert in tests.

Pearson is retained in `similarity.mjs` for comparison and is exercised by a
sanity test.

`blendedScore = 0.70 * textScore + 0.30 * imgScore` — the same 70/30 weighting
the browser code documented, so visual is a tiebreaker, not an override.

## Tests & results

### Backend (Node test runner, no network, no extra deps)

```bash
node --test server/imageRecognition/test/
```

Fixtures (synthesized PNGs): `cardA` (true art), `cardB` (mirrored twin — the
similar-art trap), `cardC` (distinct), `crop` (noisy camera crop of A).

Measured aHash similarity of the crop:

| crop vs | similarity |
|---------|-----------|
| cardA (true match) | **1.000** |
| cardB (twin art)   | 0.719 |
| cardC (distinct)   | 0.609 |

Disambiguation proof: candidates where **text alone is ambiguous** —
`B=0.82, A=0.80, C=0.78` (text-only picks the wrong twin B). After blending:

| candidate | imgScore | blendedScore |
|-----------|----------|--------------|
| **A (true)** | 1.000 | **0.860** ← winner |
| B (twin)  | 0.719 | 0.790 |
| C (dist)  | 0.609 | 0.729 |

→ the visual score **flips the ranking onto the correct card**. All 8 tests pass.

### Client (headless Chromium via Playwright, static server on 127.0.0.1)

```bash
node server/imageRecognition/test/client.playwright.mjs
```

- **Backend reachable:** `backendHook` auto-wires from config, returns 3 scored
  candidates, reorders **A to the top (blended 0.860)**, **console clean (0 errors)**.
- **Backend unreachable (dead port):** `backendHook` does **not** throw, returns
  `null`, `scoreVisually()` falls back to text-only (B first, `imgScore: null`),
  and there are **no CORS / `getImageData` / cross-origin-image errors**.

All client checks pass.

## Caveats & what productionization (#13) still needs

This is a spike; it deliberately stops short of production hardening:

- **Art crop geometry is approximate.** The browser crop rect is heuristic; real
  accuracy needs the same registration/perspective correction the scanner uses.
- **aHash is coarse.** 64 bits disambiguates a small candidate set well but won't
  identify a card from scratch and can tie on genuinely identical art. A
  production system would use a stronger perceptual hash (pHash/dHash) or a CNN
  embedding, and likely a precomputed fingerprint index keyed by card id.
- **No caching.** Each `/score` refetches candidate art. Production should cache
  fingerprints (tie in with the local card DB, epic #49 / #74 image refs) so the
  server never refetches.
- **No auth / rate limiting / input hardening** beyond an 8 MB body cap and a
  permissive CORS policy suitable for local dev.
- **Vendored JPEG decoder** is a baseline-only decoder; a real service would use
  a maintained image library (sharp/jimp) or a native codec.
- **Deployment.** #13 covers hosting, the real API surface, and wiring the
  default `IMAGE_RECOGNITION_URL` to a deployed endpoint.
