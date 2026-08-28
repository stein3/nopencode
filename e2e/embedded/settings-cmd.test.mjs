// verify-settings-cmd.mjs — /settings builtin command opens the settings page
// via BOTH entry paths: ctrl+p palette ("setting" substring match) and the
// composer's inline "/" menu (prefix match, so literal "/setting" resolves).
//
// Runs against an EMBEDDED fake engine (same pattern as question-picker.test.mjs),
// so no live engine/chatserver is needed.
//
// Cases:
//   P. palette lists /settings for "setting", description reads "Open settings",
//      Enter opens settings page, Esc closes
//   C. composer slash menu lists settings for "/setting", click opens settings,
//      no stray "/setting" message sent
//
// Run: node e2e/embedded/settings-cmd.test.mjs

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, launchBrowser, screenshot } from '../helpers/setup.mjs';

const PORT = 8159;
const BASE = `http://127.0.0.1:${PORT}`;
const SID = 'ses_settingscmd';

// ============================== fake engine =================================

const state = {
  counts: {},
  messages: [],
};
const sseClients = new Set();

function sseEmit(type, properties = {}) {
  const frame = `data: ${JSON.stringify({ type, properties })}\n\n`;
  for (const res of sseClients) {
    try { res.write(frame); } catch { /* dropped */ }
  }
}

const MESSAGES = [
  {
    info: {
      id: 'msg_settingscmd1',
      role: 'assistant',
      agent: 'build',
      modelID: 'x-preview-f-free',
      providerID: 'opencode',
      time: { created: Date.now() - 60_000 },
    },
    parts: [
      {
        id: 'part_sc1',
        type: 'text',
        text: 'Ready.',
      },
    ],
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
  state.counts[p] = (state.counts[p] ?? 0) + 1;

  try {
    // ---- test introspection + control --------------------------------------
    if (p === '/__state') {
      return json(res, { counts: state.counts });
    }
    if (p === '/__ctl') {
      const ctl = JSON.parse((await readBody(req)) || '{}');
      if (ctl.emit) sseEmit(ctl.emit.type, ctl.emit.properties ?? {});
      return json(res, { ok: true });
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

    // ---- history (chatserver stubs) ------------------------------------------
    if (p === '/api/history/sessions') {
      return json(res, [
        {
          id: SID,
          title: 'settings-cmd-probe',
          created: Date.now() - 120_000,
          updated: Date.now() - 30_000,
          message_count: 1,
          cost: 0,
        },
      ]);
    }
    if (p.endsWith('/errors')) {
      if (req.method === 'GET') return json(res, []);
      return json(res, { ok: true });
    }
    if (p.startsWith('/api/history/session/')) return json(res, []);

    // ---- engine stubs --------------------------------------------------------
    if (p === '/oc/session/status') return json(res, {});
    if (p.startsWith('/oc/session/') && p.endsWith('/message')) return json(res, MESSAGES);
    if (p.startsWith('/oc/session/')) return json(res, { id: SID, title: 'settings-cmd-probe', revert: null });
    if (p === '/oc/session' && req.method === 'POST')
      return json(res, { id: SID, title: 'settings-cmd-probe', revert: null });
    if (p === '/oc/config/providers')
      return json(res, {
        providers: [{ id: 'opencode', models: { 'x-preview-f-free': { id: 'x-preview-f-free' } } }],
      });
    if (p === '/oc/path') return json(res, { directory: '/workspace' });
    if (p === '/oc/mcp') return json(res, {});
    if (p.startsWith('/oc/')) return json(res, []);

    // ---- statics (webui/dist) -----------------------------------------------
    const rel = p === '/' ? '/index.html' : p;
    const full = fs.realpathSync(path.join(DIST, rel));
    if (!full.startsWith(fs.realpathSync(DIST)) || !fs.statSync(full).isFile())
      return json(res, { error: 'missing' }, 404);
    const ct = MIME[path.extname(full)] ?? 'application/octet-stream';
    const b = fs.readFileSync(full);
    res.writeHead(200, {
      'Content-Type': ct,
      'Content-Length': b.length,
      'Cache-Control': 'no-store',
    });
    res.end(b);
  } catch (e) {
    try { json(res, { error: String(e) }, 500); } catch { /* headers sent */ }
  }
});

// ================================ checks ====================================

const results = [];
let pageErrors = [];

function check(c, name, pass, note = '') {
  results.push({ c, name, pass: !!pass, note });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${c} · ${name}${note ? ` — ${note}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ================================ run =======================================

try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => pageErrors.push(e.message));

  try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForSelector('.sidebar .gear', { timeout: 15000 });
    const dialog = page.locator('.settings[role="dialog"]');

    // ---- CASE P: palette path ------------------------------------------------
    console.log('\nCASE P — ctrl+p palette "setting" → Enter opens settings');
    await page.keyboard.press('Control+p');
    await page.waitForSelector('.panel input', { timeout: 5000 });
    await page.keyboard.type('setting');
    await sleep(200);
    const row = page.locator('.panel .row', { hasText: 'Open settings' });
    const rowExists = (await row.count()) === 1;
    check('P', 'palette lists /settings for "setting"', rowExists);
    if (rowExists) {
      const desc = (await row.first().locator('.desc').textContent())?.trim();
      check('P', 'description reads "Open settings"', desc === 'Open settings', desc);
    }
    await page.keyboard.press('Enter');
    await page.waitForSelector('.settings[role="dialog"]', { timeout: 5000 });
    check('P', 'palette Enter opens settings page', await dialog.isVisible());

    // close again for the next path
    await page.keyboard.press('Escape');
    await sleep(150);
    check('P', 'Esc closes after palette open', (await dialog.count()) === 0);

    await screenshot(page, 'settings-cmd-palette');

    // ---- CASE C: composer slash path -----------------------------------------
    console.log('\nCASE C — composer /setting → menu click opens settings');
    const input = page.locator('.tabpane[style*="flex"] #composer-input:visible').first();
    await input.click();
    await input.fill('/setting');
    await sleep(300);
    const menuItem = page.locator('.menu[role="listbox"] .row', { hasText: '/settings' });
    const menuHits = await menuItem.count();
    check('C', 'composer slash menu lists settings for "/setting"', menuHits >= 1);
    if (menuHits >= 1) {
      await menuItem.first().click();
      await page.waitForSelector('.settings[role="dialog"]', { timeout: 5000 });
      check('C', 'composer menu click opens settings page', await dialog.isVisible());
      // composer must NOT have sent "/setting" as a message
      const bodyText = await page.locator('.tabpane[style*="flex"]').first().textContent();
      check('C', 'no stray "/setting" message sent', !bodyText?.includes('/setting'));
    }

    await screenshot(page, 'settings-cmd-composer');
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
