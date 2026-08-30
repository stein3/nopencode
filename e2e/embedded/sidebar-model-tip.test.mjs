// Verify the sidebar session-list model chip: hovering the model name shows a
// native tooltip with the FULL model name + provider/id (2026-08-30 feature).
//
// Data path: chatserver's /api/history/sessions entry gained `model_provider`
// (projected from the session JSON's providerID); Sidebar renders the bare id
// in a `.mmeta` span whose title resolves the display name from
// /oc/config/providers (same lookup as ModelPicker).
//
// Runs against an EMBEDDED fake engine: in-process HTTP server serving
// webui/dist + stubbed /oc + /api/history endpoints. No live engine needed.
//
// Run: cd webui && npm run build && node e2e/embedded/sidebar-model-tip.test.mjs

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, launchBrowser, SHOTS_DIR } from '../helpers/setup.mjs';

const PORT = 8166;
const BASE = `http://127.0.0.1:${PORT}`;

// ============================== fake engine =================================

const sseClients = new Set();

// Sessions covering every tooltip branch:
//  - named:    provider list resolves a display name ≠ id → "Name (prov/id)"
//  - unknownp: provider absent from the list                → "prov/id"
//  - sameName: name === id in the list                      → "prov/id"
//  - nomodel:  no model at all                              → no .mmeta span
const SESSIONS = [
  {
    id: 'ses_mtip_named',
    title: 'Mtip named',
    created: Date.now() - 40_000,
    updated: Date.now() - 10_000,
    message_count: 3,
    cost: 0,
    model: 'qwen3.8-flash',
    model_provider: 'testprov',
  },
  {
    id: 'ses_mtip_unknownp',
    title: 'Mtip unknown provider',
    created: Date.now() - 50_000,
    updated: Date.now() - 20_000,
    message_count: 2,
    cost: 0,
    model: 'xyz-model',
    model_provider: 'otherprov',
  },
  {
    id: 'ses_mtip_samename',
    title: 'Mtip name equals id',
    created: Date.now() - 60_000,
    updated: Date.now() - 30_000,
    message_count: 1,
    cost: 0,
    model: 'plain-model',
    model_provider: 'testprov',
  },
  {
    id: 'ses_mtip_nomodel',
    title: 'Mtip no model',
    created: Date.now() - 70_000,
    updated: Date.now() - 40_000,
    message_count: 4,
    cost: 0,
    // no model / model_provider
  },
];

const PROVIDERS = [
  {
    id: 'testprov',
    models: {
      'qwen3.8-flash': { id: 'qwen3.8-flash', name: 'Qwen3.8 Flash' },
      'plain-model': { id: 'plain-model', name: 'plain-model' },
    },
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
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain',
};

function json(res, obj, code = 200) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length });
  res.end(b);
}

const server = http.createServer(async (req, res) => {
  const p = (req.path_url ??= req.url.split('?')[0]);

  try {
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

    // ---- history (chatserver stubs) ----------------------------------------
    if (p === '/api/history/sessions') return json(res, SESSIONS);
    if (p.endsWith('/errors')) {
      if (req.method === 'GET') return json(res, []);
      return json(res, { ok: true });
    }
    const histMatch = p.match(/^\/api\/history\/session\/([^/?]+)$/);
    if (histMatch) return json(res, []);

    // ---- engine stubs --------------------------------------------------------
    if (p === '/oc/session/status') return json(res, {});
    const msgMatch = p.match(/^\/oc\/session\/([^/?]+)\/message/);
    if (msgMatch) return json(res, []);
    const sessMatch = p.match(/^\/oc\/session\/([^/?]+)$/);
    if (sessMatch) {
      const sid = sessMatch[1];
      const s = SESSIONS.find((x) => x.id === sid);
      return json(res, { id: sid, title: s?.title ?? '', revert: null });
    }
    if (p === '/oc/config/providers') return json(res, { providers: PROVIDERS });
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
    try { json(res, { error: String(e) }, 500); } catch { /* headers sent (SSE) */ }
  }
});

// ================================ run =======================================

const results = [];
const pageErrors = [];

function check(name, pass, note = '') {
  results.push({ name, pass: !!pass, note });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${note ? ` — ${note}` : ''}`);
}

try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const browser = await launchBrowser({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('.sidebar .item', { timeout: 15000 });
    // let the providers fetch land so tooltips upgrade from bare id
    await page.waitForFunction(
      () => [...document.querySelectorAll('.mmeta')].some((e) => (e.getAttribute('title') || '').includes('(')),
      { timeout: 8000 },
    ).catch(() => {});

    const rows = await page.evaluate(() => {
      const out = {};
      for (const title of ['Mtip named', 'Mtip unknown provider', 'Mtip name equals id', 'Mtip no model']) {
        const row = [...document.querySelectorAll('.sidebar .item')].find((r) =>
          r.querySelector('.ttext')?.textContent?.trim() === title,
        );
        if (!row) { out[title] = null; continue; }
        const chip = row.querySelector('.mmeta');
        out[title] = {
          text: chip?.textContent ?? null,
          title: chip?.getAttribute('title') ?? null,
          smeta: row.querySelector('.smeta')?.textContent?.trim() ?? null,
        };
      }
      return out;
    });
    console.log('rows:', JSON.stringify(rows, null, 1));

    // 1) named model → "Display Name (provider/id)"
    check('named tooltip = name (provider/id)',
      rows['Mtip named']?.title === 'Qwen3.8 Flash (testprov/qwen3.8-flash)',
      JSON.stringify(rows['Mtip named']?.title));
    // 2) visible text stays the bare model id
    check('chip text is bare id', rows['Mtip named']?.text === 'qwen3.8-flash',
      String(rows['Mtip named']?.text));
    // 3) unknown provider → full id only
    check('unknown-provider tooltip = provider/id',
      rows['Mtip unknown provider']?.title === 'otherprov/xyz-model',
      JSON.stringify(rows['Mtip unknown provider']?.title));
    // 4) name === id → no redundant name, just provider/id
    check('name==id tooltip = provider/id',
      rows['Mtip name equals id']?.title === 'testprov/plain-model',
      JSON.stringify(rows['Mtip name equals id']?.title));
    // 5) model-less session renders no chip and its meta line is untouched
    check('no-model row has no chip', rows['Mtip no model'] && rows['Mtip no model'].text === null,
      JSON.stringify(rows['Mtip no model']));
    check('no-model meta reads "4 msgs"', rows['Mtip no model']?.smeta === '4 msgs',
      JSON.stringify(rows['Mtip no model']?.smeta));
    // 6) meta line keeps the " · <id>" suffix layout
    check('meta suffix layout preserved', /·\s*qwen3\.8-flash$/.test(rows['Mtip named']?.smeta ?? ''),
      JSON.stringify(rows['Mtip named']?.smeta));

    // 7) hover keeps the title attribute (native tooltip is attribute-driven)
    const chip = page.locator('.sidebar .item', { hasText: 'Mtip named' }).locator('.mmeta');
    await chip.hover();
    await page.waitForTimeout(200);
    check('title survives hover', (await chip.getAttribute('title'))?.includes('testprov/qwen3.8-flash'));

    // 8) providers fetch failure degrades gracefully: block the endpoint, reload,
    //    tooltips must still show provider/id from the session row itself.
    await page.route(`**/oc/config/providers`, (r) => r.abort());
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('.mmeta', { timeout: 15000 });
    const degraded = await page.$$eval('.mmeta', (els) =>
      els.map((e) => e.getAttribute('title')).filter((t) => t && t.includes('/')),
    );
    check('engine-down fallback still shows provider/id', degraded.length >= 3, `${degraded.length} tips`);
    await page.unroute(`**/oc/config/providers`);

    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.mmeta', { timeout: 15000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SHOTS_DIR, 'sidebar-model-tip.png') });
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
  console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.note ? ` — ${r.note}` : ''}`);
  if (!r.pass) fails++;
}
if (pageErrors.length) {
  console.log(`\npage errors observed (${pageErrors.length}):`);
  for (const e of [...new Set(pageErrors)].slice(0, 5)) console.log('  •', e.slice(0, 220));
}
console.log('\nChecks:', results.length, '| failed:', fails);
process.exitCode = fails ? 1 : 0;
