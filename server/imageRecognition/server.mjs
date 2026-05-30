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
// CORS: responds with permissive CORS headers so the static web app (served
// from a different origin/port) can call it from the browser. NOTE: the
// browser only ever POSTs its own art crop here as JSON — it never reads
// cross-origin image pixels, so no getImageData/CORS image errors are possible.
//
// Run:  node server/imageRecognition/server.mjs            # port 8787
//       PORT=9000 node server/imageRecognition/server.mjs  # custom port

import { createServer } from 'node:http';
import { scoreCandidates } from './score.mjs';

const PORT = Number(process.env.PORT) || 8787;
const MAX_BODY = 8 * 1024 * 1024; // 8 MB cap on the request body

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  cors(res);
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
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { ok: true, service: 'imageRecognition-spike', method: 'ahash' });
  }

  if (req.method === 'POST' && req.url === '/score') {
    try {
      const raw = await readBody(req);
      const { artDataUrl, candidates } = JSON.parse(raw || '{}');
      const scored = await scoreCandidates(artDataUrl, candidates);
      return sendJson(res, 200, { candidates: scored });
    } catch (e) {
      return sendJson(res, 400, { error: String(e && e.message || e) });
    }
  }

  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`[imageRecognition spike] listening on http://127.0.0.1:${PORT}  (POST /score, GET /health)`);
});
