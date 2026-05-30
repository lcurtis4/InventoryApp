// server/imageRecognition/vendor/pngDecode.mjs — spike (#56)
//
// Minimal, dependency-free PNG decoder. Supports the subset we need for the
// art-similarity spike: 8-bit non-interlaced PNGs in greyscale, RGB, or RGBA
// (with/without an alpha channel). Decompression uses Node's built-in zlib —
// no third-party packages.
//
// Returns { width, height, data } where `data` is RGBA Uint8Array (4 B/px).
// This is enough to feed the average-hash pipeline; it is NOT a general PNG
// implementation (no interlacing, no <8-bit depths, no palette).

import { inflateSync } from 'node:zlib';

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// Hard sanity caps applied BEFORE any allocation, since width/height and the
// inflated payload size are attacker-controlled (DoS risk). On violation we
// throw so the caller's try/catch falls back to text-only.
const MAX_DIM = 4096;                       // max width or height in pixels
const MAX_PIXELS = 16 * 1024 * 1024;        // ~16 MP cap (4096*4096)
const MAX_RAW_BYTES = 256 * 1024 * 1024;    // 256 MB cap on inflated/raw payload

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePng(buf) {
  for (let i = 0; i < PNG_SIG.length; i++) {
    if (buf[i] !== PNG_SIG[i]) throw new Error('not a PNG');
  }

  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const dataStart = pos + 8;

    if (type === 'IHDR') {
      width     = buf.readUInt32BE(dataStart);
      height    = buf.readUInt32BE(dataStart + 4);
      bitDepth  = buf[dataStart + 8];
      colorType = buf[dataStart + 9];
      interlace = buf[dataStart + 12];
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(dataStart, dataStart + len));
    } else if (type === 'IEND') {
      break;
    }
    pos = dataStart + len + 4; // skip data + CRC
  }

  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth}`);
  if (interlace !== 0) throw new Error('interlaced PNG not supported');

  // Bound dimensions/pixel count BEFORE allocating the RGBA output buffer.
  if (!(width > 0) || !(height > 0)) throw new Error('invalid PNG dimensions');
  if (width > MAX_DIM || height > MAX_DIM) {
    throw new Error(`PNG too large: ${width}x${height} exceeds ${MAX_DIM}px limit`);
  }
  if (width * height > MAX_PIXELS) {
    throw new Error(`PNG pixel count ${width * height} exceeds ${MAX_PIXELS} limit`);
  }

  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported PNG color type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: MAX_RAW_BYTES });
  const bpp = channels;                 // bytes per pixel (8-bit)
  const stride = width * bpp;
  const out = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);

  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[rp++];
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let val;
      switch (filter) {
        case 0: val = rawByte; break;
        case 1: val = rawByte + a; break;
        case 2: val = rawByte + b; break;
        case 3: val = rawByte + ((a + b) >> 1); break;
        case 4: val = rawByte + paeth(a, b, c); break;
        default: throw new Error(`bad PNG filter ${filter}`);
      }
      cur[x] = val & 0xff;
    }
    // expand row to RGBA
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const s = x * bpp;
      if (channels === 1)      { out[o] = out[o+1] = out[o+2] = cur[s]; out[o+3] = 255; }
      else if (channels === 2) { out[o] = out[o+1] = out[o+2] = cur[s]; out[o+3] = cur[s+1]; }
      else if (channels === 3) { out[o] = cur[s]; out[o+1] = cur[s+1]; out[o+2] = cur[s+2]; out[o+3] = 255; }
      else                     { out[o] = cur[s]; out[o+1] = cur[s+1]; out[o+2] = cur[s+2]; out[o+3] = cur[s+3]; }
    }
    prev.set(cur);
  }

  return { width, height, data: out };
}
