// errtile.test.mjs — embedded fake engine: session.error SSE → red error tile
//
// Verifies the session-error sidecar tile (no live engine/chatserver needed):
//   A. engine session.error SSE → red tile (.msg.errtile) in transcript
//   B. tile shows the readable message (error.data.message)
//   C. no error line above composer
//   D. sending a new prompt clears the tile (session.idle → clearErrors)
//
// Port 8140 — unique per embedded test.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, launchBrowser } from '../helpers/setup.mjs';

const PORT = 8140;
const BASE = `http://127.0.0.1:${PORT}`;
const SID = 'ses_errtile01';
const ERROR_MSG = 'Model not found: does-not-exist/nope.';

// ============================== fake engine =================================

const state = {};
const sseClients = new Set();

function sseEmit(type, properties = {}) {
  const frame = `data: ${JSON.stringify({ type, properties })}\n\n`;
  for (const res of sseClients) {
    try { res.write(frame); } catch {}
  }
}

const MESSAGES = [
  {
    info: {
      id: 'msg_et1',
      role: 'user',
      time: { created: Date.now() - 5000 },
    },
    parts: [{ id: 'part_et1', type: 'text', text: 'trigger error' }],
  },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain',
};

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => resolve(buf));
  });
}

function json(res, obj, code = 200) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length });
  res.end(b);
}

const server = http.createServer(async (req, res) => {
  const p = (req.path_url ??= req.url.split('?')[0]);
  try {
    // ---- test control -------------------------------------------------------
    if (p === '/__ctl') {
      const ctl = JSON.parse((await readBody(req)) || '{}');
      if (ctl.emit) sseEmit(ctl.emit.type, ctl.emit.properties ?? {});
      return json(res, { ok: true });
    }
    if (p === '/__state') {
      return json(res, state);
    }

    // ---- SSE -----------------------------------------------------------------
    if (p === '/oc/event') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    // ---- engine stubs -------------------------------------------------------
    if (p === '/oc/session/status') return json(res, {});
    if (p === '/oc/session' && req.method === 'GET')
      return json(res, [{ id: SID, title: 'errtile-probe', revert: null }]);
    if (p.startsWith('/oc/session/') && p.endsWith('/message'))
      return json(res, MESSAGES);
    if (p.startsWith('/oc/session/') && p.endsWith('/prompt_async') && req.method === 'POST')
      return json(res, { ok: true }, 204);
    if (p.startsWith('/oc/session/') && req.method === 'GET')
      return json(res, { id: SID, title: 'errtile-probe', revert: null });
    if (p === '/oc/session' && req.method === 'POST')
      return json(res, { id: SID, title: 'errtile-probe', revert: null });
    if (p === '/oc/config/providers')
      return json(res, {
        providers: [{ id: 'opencode', models: { 'x-preview-f-free': { id: 'x-preview-f-free' } } }],
      });
    if (p === '/oc/path') return json(res, { directory: '/workspace' });
    if (p === '/oc/mcp') return json(res, {});
    if (p === '/oc/question') return json(res, []);
    if (p === '/oc/permission') return json(res, []);
    if (p === '/oc/skill') return json(res, []);
    if (p === '/oc/command') return json(res, []);
    if (p.startsWith('/oc/')) return json(res, []);

    // ---- history stubs ------------------------------------------------------
    if (p === '/api/history/sessions') {
      return json(res, [
        { id: SID, title: 'errtile-probe', created: Date.now() - 60_000, updated: Date.now() - 10_000, message_count: 1, cost: 0 },
      ]);
    }
    if (p.endsWith('/errors')) {
      if (req.method === 'GET') return json(res, []);
      if (req.method === 'DELETE') return json(res, { ok: true });
      return json(res, { ok: true }); // POST
    }
    if (p.startsWith('/api/history/session/')) return json(res, []);

    // ---- statics (webui/dist) -----------------------------------------------
    const rel = p === '/' ? '/index.html' : p;
    const full = fs.realpathSync(path.join(DIST, rel));
    if (!full.startsWith(fs.realpathSync(DIST)) || !fs.statSync(full).isFile())
      return json(res, { error: 'missing' }, 404);
    const ct = MIME[path.extname(full)] ?? 'application/octet-stream';
    const b = fs.readFileSync(full);
    res.writeHead(200, { 'Content-Type': ct, 'Content-Length': b.length, 'Cache-Control': 'no-store' });
    res.end(b);
  } catch (e) {
    try { json(res, { error: String(e) }, 500); } catch {}
  }
});

// ================================ helpers ===================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const poll = async (fn, timeout = 1500, iv = 100) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await fn()) return true;
    await sleep(iv);
  }
  return !!(await fn());
};
const ctl = (payload) =>
  fetch(`${BASE}/__ctl`, { method: 'POST', body: JSON.stringify(payload) }).then((r) => r.json());

// ================================ run =======================================

const results = [];
let pageErrors = [];

function check(name, pass, note = '') {
  results.push({ name, pass: !!pass, note });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${note ? ` — ${note}` : ''}`);
}

try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  await fetch(`${BASE}/__state`); // warm + sanity

  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => pageErrors.push(e.message));

  try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // Open the probe session
    const item = page.locator('.sidebar button.item', { hasText: 'errtile-probe' }).first();
    await item.waitFor({ timeout: 15000 });
    await item.click();
    await page.waitForTimeout(800);

    // ---- A+B. trigger session.error SSE → red tile with readable message ----
    console.log('\nCASE A+B — session.error → red tile with message');
    await ctl({
      emit: {
        type: 'session.error',
        properties: {
          sessionID: SID,
          error: {
            name: 'APIError',
            data: { message: ERROR_MSG },
          },
        },
      },
    });

    const tile = page.locator('.msg.errtile');
    await tile.waitFor({ timeout: 20000 });
    check('A', 'error tile rendered after session.error SSE', await tile.isVisible());
    const tileText = (await tile.innerText()).trim();
    check('B', 'tile shows readable error message', tileText.includes(ERROR_MSG), JSON.stringify(tileText));

    // ---- C. no error line above composer -------------------------------------
    console.log('\nCASE C — no error line above composer');
    check('C', 'no .composer .error element', (await page.locator('.composer .error').count()) === 0);

    // ---- D. new send clears the tile optimistically -------------------------
    // The webui's prompt_async POST returns 204 (accepted). The error tile
    // clears when session.idle fires (clearErrors in sse.ts). We emit
    // session.idle via /__ctl to simulate the engine finishing the turn.
    console.log('\nCASE D — send clears error tile');
    const pane = page.locator('.tabpane[style*="flex"]');
    const input = pane.locator('#composer-input');
    await input.fill('try again');
    await page.keyboard.press('Enter');

    // Wait for the POST to leave the browser, then simulate the engine
    // finishing the turn — session.idle triggers clearErrors.
    await sleep(300);
    await ctl({
      emit: {
        type: 'session.idle',
        properties: { sessionID: SID },
      },
    });

    const tileCleared = await poll(async () => (await tile.count()) === 0, 5000);
    check('D', 'tile cleared after new send + session.idle', tileCleared);

    // prompt_async returns 204 (no error) → send-failed banner should NOT appear
    const sendFail = await pane.locator('.composer .error').count();
    check('D', 'no send-failed banner (prompt accepted)', sendFail === 0);
  } finally {
    await browser.close();
  }
} finally {
  await new Promise((r) => server.close(r));
}

// =============================== summary ====================================

console.log('\n================ SUMMARY ================');
let fails = 0;
for (const r of results) {
  if (!r.pass) fails++;
}
if (pageErrors.length) {
  console.log(`\npage errors observed (${pageErrors.length}):`);
  for (const e of [...new Set(pageErrors)].slice(0, 5)) console.log('  •', e.slice(0, 220));
}
console.log('\nChecks:', results.length, '| failed:', fails);
process.exitCode = fails ? 1 : 0;
