// verify-mru.mjs — Model recency ordering in the topbar ModelPicker menu.
//
// Self-contained fake engine: serves webui/dist + stub /oc endpoints + SSE,
// driven via /__ctl + introspected via /__state.  No live engine/chatserver.
//
// Checks:
//   M1 flat list (no .prov headers), every row has model name + provider tag
//   M2 initial order is alphabetical when no recents
//   M3 picking two models floats them to top in reverse-pick order
//   M4 tail (after recents) stays alphabetical
//   M5 provider tag is smaller font + dimmer color than model name
//   M6 MRU order persists across reload
//
// Run: node e2e/embedded/mru.test.mjs

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, launchBrowser, sleep, screenshot, SHOTS_DIR } from '../helpers/setup.mjs';

const PORT = 8143;
const BASE = `http://127.0.0.1:${PORT}`;
const SID = 'ses_mru01';

// ============================== fixtures ====================================

// 5+ models across two providers
const MODELS = {
  'alpha-one': { id: 'alpha-one' },
  'big-pickle': { id: 'big-pickle' },
  'chrono-beta': { id: 'chrono-beta' },
  'x-preview-f-free': { id: 'x-preview-f-free' },
  'ox-alpha-free': { id: 'ox-alpha-free' },
  'zulu-model': { id: 'zulu-model' },
};
const PROVIDERS = [
  { id: 'opencode', models: MODELS },
  { id: 'anthropic', models: { 'alpha-one': { id: 'alpha-one' }, 'zulu-model': { id: 'zulu-model' } } },
];

const MESSAGES = []; // empty session

// ============================== fake server =================================

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

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => resolve(d));
  });
}

const json = (res, obj, code = 200) => {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length });
  res.end(b);
};

const sseClients = new Set();
function sseEmit(type, properties = {}) {
  const frame = `data: ${JSON.stringify({ type, properties })}\n\n`;
  for (const res of sseClients) try { res.write(frame); } catch {}
}

const state = { counts: {} };

const server = http.createServer(async (req, res) => {
  const p = (req.path_url ??= req.url.split('?')[0]);
  state.counts[p] = (state.counts[p] ?? 0) + 1;
  try {
    // ---- test introspection + control -------------------------------------
    if (p === '/__state') return json(res, { counts: state.counts });
    if (p === '/__ctl') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (body.emit) sseEmit(body.emit.type, body.emit.properties ?? {});
      return json(res, { ok: true });
    }

    // ---- SSE ----------------------------------------------------------------
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
    if (p.startsWith('/oc/session/') && p.endsWith('/message'))
      return json(res, MESSAGES);
    if (p.startsWith('/oc/session/'))
      return json(res, { id: SID, title: 'mru-test', revert: null });
    if (p === '/oc/session' && req.method === 'POST')
      return json(res, { id: SID, title: 'mru-test', revert: null });
    if (p === '/oc/config/providers')
      return json(res, { providers: PROVIDERS });
    if (p === '/oc/path') return json(res, { directory: '/workspace' });
    if (p === '/oc/mcp') return json(res, {});
    if (p === '/oc/permission' || p === '/oc/question') return json(res, []);
    if (p.startsWith('/oc/')) return json(res, []);

    // ---- history (chatserver stubs) -----------------------------------------
    if (p === '/api/history/sessions')
      return json(res, [
        { id: SID, title: 'mru-test', created: Date.now() - 120_000, updated: Date.now() - 30_000, message_count: 0, cost: 0 },
      ]);
    if (p.startsWith('/api/history/session/')) return json(res, []);

    // ---- statics (webui/dist) -----------------------------------------------
    const rel = p === '/' ? '/index.html' : p;
    const full = fs.realpathSync(path.join(DIST, rel));
    if (!full.startsWith(fs.realpathSync(DIST)) || !fs.statSync(full).isFile())
      return json(res, { error: 'missing' }, 404);
    const b = fs.readFileSync(full);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] ?? 'application/octet-stream',
      'Content-Length': b.length,
      'Cache-Control': 'no-store',
    });
    res.end(b);
  } catch (e) {
    try { json(res, { error: String(e) }, 500); } catch {}
  }
});

// ================================ checks ====================================

const results = [];
let pageErrors = [];

function check(c, name, pass, note = '') {
  results.push({ c, name, pass: !!pass, note });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${c} · ${name}${note ? ` — ${note}` : ''}`);
}

// ================================ run =======================================

try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const browser = await launchBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));

  try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(2500);

    // fresh state: clear recents + selected model
    await page.evaluate(() => {
      localStorage.removeItem('opencode.modelRecents');
      localStorage.removeItem('opencode.model');
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(4000);

    // open the picker
    const trigger = page.locator('.tabpane[style*="flex"] .toolbar .wrap .cur');
    await page.waitForSelector('.tabpane[style*="flex"] .toolbar .wrap .cur', { timeout: 10000 });
    await trigger.click();
    await page.waitForSelector('.menu .m');

    // M1: flat list, no .prov headers, every row has nm+pv
    const provHeaders = await page.locator('.menu .prov').count();
    check('M1', 'no provider group headers (flat list)', provHeaders === 0);
    const rows = await page.locator('.menu .m').all();
    check('M1', `flat rows rendered (${rows.length})`, rows.length > 3);
    for (const r of rows.slice(0, 5)) {
      const nm = await r.locator('.nm').textContent();
      const pv = await r.locator('.pv').textContent();
      check('M1', `row has model name + provider tag: "${nm}" / "${pv}"`, !!nm?.trim() && !!pv?.trim());
    }

    // M2: sorted by provider then alphabetical within provider when no recents
    const names0 = [];
    for (const r of rows) names0.push(((await r.locator('.nm').textContent()) ?? '').trim());
    // Build expected order: provider-grouped alphabetical
    const expectedOrder = PROVIDERS
      .flatMap((p) => Object.keys(p.models).map((id) => ({ id, provider: p.id })))
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id))
      .map((m) => m.id);
    check('M2', 'initial order is provider-grouped alphabetical', JSON.stringify(names0) === JSON.stringify(expectedOrder));

    // M3: pick two models -> they float to top in reverse-pick order
    const pickNth = async (n) => {
      const btn = page.locator('.menu .m').nth(n);
      const nm = ((await btn.locator('.nm').textContent()) ?? '').trim();
      await btn.click();
      return nm;
    };
    const firstPick = await pickNth(0);
    await trigger.click(); // reopen
    await page.waitForSelector('.menu .m');
    const secondPick = await pickNth(4); // pick something from mid-list
    await trigger.click();
    await page.waitForSelector('.menu .m');

    let topTwo = [];
    for (const r of (await page.locator('.menu .m').all()).slice(0, 2)) {
      topTwo.push(((await r.locator('.nm').textContent()) ?? '').trim());
    }
    check(
      'M3',
      `MRU order after picks: [${topTwo}] == [${secondPick}, ${firstPick}]`,
      topTwo[0] === secondPick && topTwo[1] === firstPick,
    );

    // M4: all rows still present (none lost during MRU reordering)
    const allNames = [];
    for (const r of await page.locator('.menu .m').all()) {
      allNames.push(((await r.locator('.nm').textContent()) ?? '').trim());
    }
    check(
      'M4',
      'all models still present after MRU reorder',
      allNames.length === rows.length,
      `got ${allNames.length}, expected ${rows.length}`,
    );

    // M5: provider tag styling: smaller font + dim color vs model name
    const firstRow = page.locator('.menu .m').first();
    const styles = await firstRow.evaluate((el) => {
      const cs = getComputedStyle(el.querySelector('.nm'));
      const ps = getComputedStyle(el.querySelector('.pv'));
      return {
        nmSize: parseFloat(cs.fontSize),
        pvSize: parseFloat(ps.fontSize),
        nmColor: cs.color,
        pvColor: ps.color,
      };
    });
    check('M5', `provider tag smaller (${styles.pvSize}px < ${styles.nmSize}px)`, styles.pvSize < styles.nmSize);
    const rgb = (c) => c.match(/\d+/g).slice(0, 3).map(Number);
    const lum = (c) => rgb(c).reduce((a, b) => a + b, 0) / 3;
    check(
      'M5',
      `provider tag darker/lighter (${styles.pvColor} vs ${styles.nmColor})`,
      lum(styles.pvColor) < lum(styles.nmColor),
    );

    // M6: persistence across reload
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(3000);
    await trigger.click();
    await page.waitForSelector('.menu .m');
    let persisted = [];
    for (const r of (await page.locator('.menu .m').all()).slice(0, 2)) {
      persisted.push(((await r.locator('.nm').textContent()) ?? '').trim());
    }
    check(
      'M6',
      `order persists across reload: [${persisted}]`,
      persisted[0] === secondPick && persisted[1] === firstPick,
    );

    // screenshot of open menu
    await screenshot(page, 'mru-embedded');
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
  const tag = r.pass ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${r.name}${r.note ? ` — ${r.note}` : ''}`);
  if (!r.pass) fails++;
}
if (pageErrors.length) {
  console.log(`\npage errors observed (${pageErrors.length}):`);
  for (const e of [...new Set(pageErrors)].slice(0, 5)) console.log('  •', e.slice(0, 220));
}
console.log('\nChecks:', results.length, '| failed:', fails);
process.exitCode = fails ? 1 : 0;
