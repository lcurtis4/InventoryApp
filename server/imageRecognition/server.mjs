#!/usr/bin/env node
// server/imageRecognition/server.mjs — spike (#56)
//
// Standalone, dependency-free HTTP service for server-side visual card
// recognition. It exists to prove out the ImageAssist.backendHook extension
// point without the browser CORS limitation (the browser cannot read
// YGOPRODeck art pixels; the server can fetch them freely).
//
// ENDPOINTS
//   GET  /health  → { ok: true }
//   POST /score   → body: { artDataUrl: string, candidates: object[] }
//                   resp: { candidates: object[] }  (each + imgScore + blendedScore)
//
// CORS: echoes back only an explicitly-allowed Origin (ALLOWED_ORIGIN env,
// comma-separated; defaults to localhost for this spike) — never '*'. The
// browser only ever POSTs its own art crop here as JSON, it never reads
// cross-origin image pixels, so no getImageData/CORS image errors are possible.
//
// Run:  node server/imageRecognition/server.mjs            # port 8787
//       PORT=9000 node server/imageRecognition/server.mjs  # custom port
//       ALLOWED_ORIGIN=http://localhost:5500 node server/imageRecognition/server.mjs

import { createServer } from 'node:http';
import { scoreCandidates } from './score.mjs';

const PORT = Number(process.env.PORT) || 8787;
const MAX_BODY = 8 * 1024 * 1024; // 8 MB cap on the request body

// Allowed CORS origins. Configurable via ALLOWED_ORIGIN (comma-separated);
// defaults to localhost for this local spike. We never blanket-allow '*' —
// productionizing (#13) still needs a real allowlist (see server/README.md).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN ||
  'http://127.0.0.1,http://localhost')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

function cors(res, req) {
  // Only echo back an Origin we explicitly allow; otherwise send no
  // Access-Control-Allow-Origin header at all (the browser then blocks it).
  const origin = req && req.headers && req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res, status, obj, req) {
  const body = JSON.stringify(obj);
  cors(res, req);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { cors(res, req); res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { ok: true, service: 'imageRecognition-spike', method: 'ahash' }, req);
  }

  if (req.method === 'POST' && req.url === '/score') {
    try {
      const raw = await readBody(req);
      const { artDataUrl, candidates } = JSON.parse(raw || '{}');
      const scored = await scoreCandidates(artDataUrl, candidates);
      return sendJson(res, 200, { candidates: scored }, req);
    } catch (e) {
      return sendJson(res, 400, { error: String(e && e.message || e) }, req);
    }
  }

  sendJson(res, 404, { error: 'not found' }, req);
});

server.listen(PORT, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`[imageRecognition spike] listening on http://127.0.0.1:${PORT}  (POST /score, GET /health)`);
});
