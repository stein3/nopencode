// errtile-persist.test.mjs — embedded fake engine: persisted error tiles
//
// Verifies that session-error tiles persist across reload via sidecar
// /api/history/session/{id}/errors persistence (no live engine/chatserver needed):
//   A. session.error SSE → red tile, readable message, no composer error
//   B. tile persists across reload (loaded from /api/history/session/{id}/errors)
//   C. send clears tile locally (clearErrors) but sidecar DELETE is intercepted
//      so the error remains on the server
//   D. tile reappears after another reload (restored from sidecar)
//
// Port 8141 — unique per embedded test.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, launchBrowser } from '../helpers/setup.mjs';

const PORT = 8141;
const BASE = `http://127.0.0.1:${PORT}`;
const SID = 'ses_errp01';
const ERROR_MSG = 'Model not found: does-not-exist/nope.';

// ============================== fake engine =================================

// In-memory error store (simulates sidecar webui.db serr table)
const storedErrors = [];
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
      id: 'msg_ep1',
      role: 'user',
      time: { created: Date.now() - 5000 },
    },
    parts: [{ id: 'part_ep1', type: 'text', text: 'trigger error' }],
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
      return json(res, { storedErrors, ...state });
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
      return json(res, [{ id: SID, title: 'errtile-probe-persist', revert: null }]);
    if (p.startsWith('/oc/session/') && p.endsWith('/message'))
      return json(res, MESSAGES);
    if (p.startsWith('/oc/session/') && p.endsWith('/prompt_async') && req.method === 'POST')
      return json(res, { ok: true }, 204);
    if (p.startsWith('/oc/session/') && req.method === 'GET')
      return json(res, { id: SID, title: 'errtile-probe-persist', revert: null });
    if (p === '/oc/session' && req.method === 'POST')
      return json(res, { id: SID, title: 'errtile-probe-persist', revert: null });
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

    // ---- history stubs (with error persistence) ------------------------------
    if (p === '/api/history/sessions') {
      return json(res, [
        { id: SID, title: 'errtile-probe-persist', created: Date.now() - 60_000, updated: Date.now() - 10_000, message_count: 1, cost: 0 },
      ]);
    }
    if (p.endsWith('/errors')) {
      if (req.method === 'GET') return json(res, storedErrors);
      if (req.method === 'DELETE') {
        storedErrors.length = 0;
        return json(res, { ok: true });
      }
      // POST — webui persists a witnessed error
      const body = JSON.parse((await readBody(req)) || '{}');
      // deduplicate by message (mirrors webui.db UNIQUE(sid,msg))
      if (body.message && !storedErrors.some((e) => e.message === body.message)) {
        storedErrors.push({ message: body.message, t: body.t ?? Date.now() });
      }
      return json(res, { ok: true });
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

async function openProbe(page) {
  const item = page.locator('.sidebar button.item', { hasText: 'errtile-probe-persist' }).first();
  await item.waitFor({ timeout: 15000 });
  await item.click();
  await page.waitForTimeout(700);
}

try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  await fetch(`${BASE}/__state`); // warm + sanity

  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => pageErrors.push(e.message));

  // Intercept prompt_async to return 502 (simulates dispatch failure).
  // This triggers the failedSend path which shows the send-failed banner.
  // The key: onSent still fires (before the POST completes), which calls
  // clearErrors locally — but we intercept the DELETE below to preserve
  // the sidecar so the tile survives reload.
  await page.route('**/oc/session/*/prompt_async', (route) => {
    if (route.request().method() === 'POST')
      return route.fulfill({ status: 502, contentType: 'text/plain', body: 'mocked dispatch failure' });
    return route.fallback();
  });

  // Intercept the sidecar DELETE that fires on clearErrors → prevents the
  // persisted error from being wiped, so the tile survives reload.
  await page.route('**/api/history/session/*/errors', (route) => {
    if (route.request().method() === 'DELETE')
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    return route.fallback();
  });

  try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);
    await openProbe(page);

    // ---- A. trigger session.error SSE → red tile with readable message ------
    console.log('\nCASE A — session.error → red tile with message');
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
    check('A', 'tile shows readable error message', tileText.includes(ERROR_MSG), JSON.stringify(tileText));
    check('A', 'no composer error line', (await page.locator('.composer .error').count()) === 0);

    // Verify the error was persisted to sidecar
    const persisted = await fetch(`${BASE}/api/history/session/${SID}/errors`).then((r) => r.json());
    check('A', 'error persisted to sidecar', persisted.some((e) => e.message === ERROR_MSG), JSON.stringify(persisted));

    // ---- B. reload → tile persists from sidecar ------------------------------
    console.log('\nCASE B — tile persists across reload');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await openProbe(page);
    await tile.waitFor({ timeout: 8000 });
    const tileTextAfterReload = (await tile.innerText()).trim();
    check('B', 'tile visible after reload', await tile.isVisible());
    check('B', 'tile text preserved after reload', tileTextAfterReload.includes(ERROR_MSG), JSON.stringify(tileTextAfterReload));

    // ---- C. send clears tile locally but persists on server -------------------
    // onSent → clearErrors removes tab.errors locally, and the sidecar DELETE
    // is intercepted to keep the error on the server. After reload the tile
    // reappears from the sidecar.
    console.log('\nCASE C — send clears tile locally, persists on server');
    const pane = page.locator('.tabpane[style*="flex"]');
    const input = pane.locator('#composer-input');
    await input.fill('try again');
    await page.keyboard.press('Enter');
    await sleep(800); // let clearErrors + openLive land

    // Tile is gone locally (clearErrors removed tab.errors)
    check('C', 'tile cleared locally after send', (await tile.count()) === 0);

    // prompt_async returns 502 → send-failed banner visible
    const bannerVisible = await poll(async () => {
      const cnt = await pane.locator('.composer .error').count();
      return cnt > 0;
    }, 3000);
    check('C', 'send-failed banner shown (mocked 502)', bannerVisible);

    // But the sidecar still has the error (DELETE was intercepted)
    const stillPersisted = await fetch(`${BASE}/api/history/session/${SID}/errors`).then((r) => r.json());
    check('C', 'error still in sidecar after send', stillPersisted.some((e) => e.message === ERROR_MSG));

    // ---- D. tile reappears after reload (loaded from sidecar) ----------------
    console.log('\nCASE D — tile reappears after reload (sidecar persistence)');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await openProbe(page);
    await tile.waitFor({ timeout: 8000 });
    check('D', 'tile visible after reload (restored from sidecar)', (await tile.count()) === 1);
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
