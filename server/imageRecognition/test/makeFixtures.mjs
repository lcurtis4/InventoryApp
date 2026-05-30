// server/imageRecognition/test/makeFixtures.mjs — spike (#56)
//
// Generates deterministic PNG fixtures for the similarity tests. No external
// deps: a minimal PNG encoder using Node's zlib. We synthesize a scene with:
//   • cardA.png      — "official art" of card A (a blue gradient + a sun motif)
//   • cardB.png      — "official art" of card B, SAME palette/composition as A
//                      but mirrored (the classic similar-art / alt-art trap)
//   • cardC.png      — visually distinct art (red diagonal stripes)
//   • crop.png       — a noisy, recompressed-looking "camera crop" of card A
//
// The point: by NAME/text these could all tie; only the visual hash separates
// the true match (A) from its near-twin (B) and the distractor (C).

import { writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const SIZE = 64;

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

// rgba: Uint8Array length SIZE*SIZE*4 → PNG buffer (RGBA, 8-bit, non-interlaced)
function encodePng(rgba, size = SIZE) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // add per-row filter byte 0
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.subarray(y * stride, (y + 1) * stride).forEach((v, i) => { raw[y * (stride + 1) + 1 + i] = v; });
  }
  const idat = deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function blank() { return new Uint8Array(SIZE * SIZE * 4); }
function put(px, x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
}

// Card A: blue vertical gradient + bright sun disc in the UPPER-LEFT quadrant.
function drawA(noise = 0, mirror = false) {
  const px = blank();
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const xx = mirror ? SIZE - 1 - x : x;
      const base = 40 + Math.floor((y / SIZE) * 120);
      let r = 20, g = 60, b = base;
      // sun disc
      const cx = 18, cy = 18, rad = 12;
      if ((xx - cx) ** 2 + (y - cy) ** 2 < rad * rad) { r = 250; g = 230; b = 80; }
      if (noise) {
        const n = (Math.sin((x * 12.9898 + y * 78.233)) * 43758.5453) % 1;
        const d = Math.floor(n * noise);
        r = Math.max(0, Math.min(255, r + d));
        g = Math.max(0, Math.min(255, g + d));
        b = Math.max(0, Math.min(255, b + d));
      }
      put(px, x, y, r, g, b);
    }
  }
  return px;
}

// Card C: red background with bright diagonal stripes — clearly different.
function drawC() {
  const px = blank();
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const stripe = ((x + y) % 12) < 6;
      put(px, x, y, stripe ? 230 : 120, stripe ? 40 : 10, stripe ? 40 : 10);
    }
  }
  return px;
}

export async function buildFixtures() {
  const files = {
    'cardA.png': encodePng(drawA(0, false)),       // official A
    'cardB.png': encodePng(drawA(0, true)),        // official B = mirrored A (similar art twin)
    'cardC.png': encodePng(drawC()),               // distinct distractor
    'crop.png':  encodePng(drawA(40, false)),      // camera crop of A (noisy)
  };
  for (const [name, buf] of Object.entries(files)) {
    await writeFile(join(DIR, name), buf);
  }
  return Object.keys(files);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildFixtures().then((f) => console.log('wrote fixtures:', f.join(', ')));
}
