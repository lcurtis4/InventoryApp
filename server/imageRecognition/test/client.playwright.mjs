// server/imageRecognition/test/client.playwright.mjs — spike (#56)
//
// Headless-Chromium verification of the CLIENT side of the spike:
//   A) backend reachable   → backendHook returns candidates reordered by
//                            blendedScore, console stays clean.
//   B) backend unreachable → backendHook resolves to null (graceful fallback),
//                            scoreVisually() falls back to text-only, console
//                            stays clean (NO CORS / getImageData / fetch errors).
//
// Self-contained: starts the real backend, a static server for the app + the
// art fixtures, drives a real browser via Playwright. No test framework.
//
// Run: node server/imageRecognition/test/client.playwright.mjs

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

import { scoreCandidates } from '../score.mjs';
import { buildFixtures } from './makeFixtures.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('/home/user/node_modules/playwright/index.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const FIX = join(HERE, 'fixtures');

const log = (...a) => console.log('[client-test]', ...a);
let failures = 0;
function check(cond, msg) {
  if (cond) log('PASS:', msg);
  else { failures++; log('FAIL:', msg); }
}

// ── 1. backend (real /score) ────────────────────────────────────────────────
function startBackend() {
  return new Promise((res) => {
    const srv = createServer(async (req, r) => {
      r.setHeader('Access-Control-Allow-Origin', '*');
      r.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      r.setHeader('Access-Control-Allow-Methods', 'POST,GET,OPTIONS');
      if (req.method === 'OPTIONS') { r.writeHead(204); r.end(); return; }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        try {
          const { artDataUrl, candidates } = JSON.parse(body || '{}');
          // Serve fixture art from disk via a fetch impl keyed on filename.
          const scored = await scoreCandidates(artDataUrl, candidates, {
            fetchImpl: async (url) => {
              const name = String(url).split('/').pop();
              try {
                const buf = await readFile(join(FIX, name));
                return { ok: true, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
              } catch { return { ok: false }; }
            },
          });
          r.writeHead(200, { 'Content-Type': 'application/json' });
          r.end(JSON.stringify({ candidates: scored }));
        } catch (e) {
          r.writeHead(400); r.end(JSON.stringify({ error: String(e) }));
        }
      });
    });
    srv.listen(0, '127.0.0.1', () => res(srv));
  });
}

// ── 2. static server for app files + a host page ────────────────────────────
function startStatic() {
  return new Promise((res) => {
    const srv = createServer(async (req, r) => {
      const url = (req.url || '/').split('?')[0];
      try {
        if (url === '/' || url === '/host.html') {
          r.writeHead(200, { 'Content-Type': 'text/html' });
          r.end('<!doctype html><meta charset="utf-8"><title>spike host</title>');
          return;
        }
        // serve repo files (e.g. /js/scanner/imageAssist.js)
        const buf = await readFile(join(REPO, url.replace(/^\//, '')));
        const type = url.endsWith('.js') ? 'application/javascript' : 'text/plain';
        r.writeHead(200, { 'Content-Type': type });
        r.end(buf);
      } catch { r.writeHead(404); r.end('nf'); }
    });
    srv.listen(0, '127.0.0.1', () => res(srv));
  });
}

async function main() {
  await buildFixtures();
  const cropDataUrl = 'data:image/png;base64,' + (await readFile(join(FIX, 'crop.png'))).toString('base64');

  const backend = await startBackend();
  const stat = await startStatic();
  const backendPort = backend.address().port;
  const statPort = stat.address().port;
  const backendUrl = `http://127.0.0.1:${backendPort}/score`;
  const appBase = `http://127.0.0.1:${statPort}`;

  const browser = await chromium.launch();

  // Candidates: text-only would rank B(0.82) first; A is the true visual match.
  const candidates = [
    { name: 'B twin', id: 2, imageUrl: 'http://art/cardB.png', score: 0.82 },
    { name: 'A true', id: 1, imageUrl: 'http://art/cardA.png', score: 0.80 },
    { name: 'C dist', id: 3, imageUrl: 'http://art/cardC.png', score: 0.78 },
  ];

  async function runScenario(label, recUrl) {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
    page.on('requestfailed', (req) => {
      // Record cross-origin image request failures (the #27 CORS class).
      consoleErrors.push('requestfailed: ' + req.url() + ' ' + (req.failure()?.errorText || ''));
    });

    await page.goto(`${appBase}/host.html`);
    // Configure BEFORE loading imageAssist.js so the hook auto-wires.
    await page.evaluate((url) => { window.APP_CONFIG = { IMAGE_RECOGNITION_URL: url }; }, recUrl);
    await page.addScriptTag({ url: `${appBase}/js/scanner/imageAssist.js` });

    const out = await page.evaluate(async ({ dataUrl, cands }) => {
      const ia = window.ImageAssist;
      const hookType = typeof ia.backendHook;
      let hookResult = null, hookThrew = false;
      try {
        hookResult = ia.backendHook ? await ia.backendHook(dataUrl, cands) : null;
      } catch (e) { hookThrew = true; }
      // Also exercise scoreVisually's fallback contract with no frame canvas:
      const sv = await ia.scoreVisually(cands, document.createElement('canvas'));
      return { hookType, hookResult, hookThrew, sv };
    }, { dataUrl: cropDataUrl, cands: candidates });

    await page.close();
    return { out, consoleErrors };
  }

  // ── Scenario A: backend reachable ─────────────────────────────────────────
  log('--- Scenario A: backend REACHABLE ---');
  {
    const { out, consoleErrors } = await runScenario('A', backendUrl);
    check(out.hookType === 'function', 'backendHook is auto-wired when URL configured');
    check(!out.hookThrew, 'backendHook did not throw');
    check(Array.isArray(out.hookResult) && out.hookResult.length === 3, 'backend returned 3 scored candidates');
    if (Array.isArray(out.hookResult)) {
      const top = out.hookResult[0];
      log('  top blended:', top && top.name, top && Number(top.blendedScore).toFixed(3),
          'imgScore=', top && Number(top.imgScore).toFixed(3));
      check(top && top.id === 1, 'blendedScore reorders true visual match A to the top (text-only would pick B)');
      const allHaveScores = out.hookResult.every(c => typeof c.imgScore === 'number' && typeof c.blendedScore === 'number');
      check(allHaveScores, 'every candidate annotated with imgScore + blendedScore');
    }
    check(consoleErrors.length === 0, `console clean (no CORS/errors): ${JSON.stringify(consoleErrors)}`);
  }

  // ── Scenario B: backend UNREACHABLE ───────────────────────────────────────
  log('--- Scenario B: backend UNREACHABLE (graceful fallback) ---');
  {
    // Point at a dead port (nothing listening) → fetch fails → hook returns null.
    const dead = `http://127.0.0.1:${backendPort + 1}/score`;
    const { out, consoleErrors } = await runScenario('B', dead);
    check(out.hookType === 'function', 'backendHook still wired (URL configured)');
    check(!out.hookThrew, 'backendHook did NOT throw on unreachable backend');
    check(out.hookResult === null, 'backendHook returns null on unreachable backend (signals fallback)');
    check(Array.isArray(out.sv) && out.sv.length === 3, 'scoreVisually fell back to text-only ranking');
    if (Array.isArray(out.sv)) {
      check(out.sv.every(c => c.imgScore === null), 'fallback path leaves imgScore null (text-only)');
      check(out.sv[0].id === 2, 'text-only fallback ranks by score (B first)');
    }
    // A failed fetch to a dead port logs a net::ERR_CONNECTION_REFUSED as a
    // requestfailed — but it must NOT be a CORS/getImageData IMAGE error and the
    // hook must swallow it. We assert no CORS-image errors specifically.
    const corsImageErrors = consoleErrors.filter(e =>
      /CORS/i.test(e) || /getImageData/i.test(e) || /cards_small/i.test(e) || /ygoprodeck/i.test(e));
    check(corsImageErrors.length === 0, `no CORS/getImageData/cross-origin-image errors: ${JSON.stringify(corsImageErrors)}`);
  }

  await browser.close();
  backend.close(); stat.close();

  log(failures === 0 ? 'ALL CLIENT CHECKS PASSED' : `${failures} CLIENT CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
