// server/imageRecognition/vendor/decodeImage.mjs — spike (#56)
//
// Tiny facade: sniff the byte signature and decode a JPEG or PNG buffer to a
// uniform { width, height, data: RGBA Uint8Array } shape.
//
//   • JPEG → vendored baseline decoder (jpeg-js, BSD-2 / Apache-2.0; see
//     jpeg-js-LICENSE.txt). Card art from YGOPRODeck is baseline JPEG.
//   • PNG  → our own zlib-based decoder (pngDecode.mjs). Used by the test
//     fixtures so the test suite needs no network and no extra packages.
//
// Dependency-free at runtime (matches the repo's zero-dep Node convention).

import { createRequire } from 'node:module';
import { decodePng } from './pngDecode.mjs';

const require = createRequire(import.meta.url);
const decodeJpeg = require('./jpegDecode.cjs');

function isPng(b) {
  return b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
}
function isJpeg(b) {
  return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

export function decodeImage(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (isPng(b)) return decodePng(b);
  if (isJpeg(b)) {
    const img = decodeJpeg(b, { useTArray: true, formatAsRGBA: true });
    return { width: img.width, height: img.height, data: img.data };
  }
  throw new Error('unsupported image format (expected JPEG or PNG)');
}

// Parse a data: URL (e.g. "data:image/jpeg;base64,....") into a Buffer.
export function bufferFromDataUrl(dataUrl) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl || '');
  if (!m) throw new Error('invalid data URL');
  const isBase64 = !!m[2];
  return isBase64 ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
}
