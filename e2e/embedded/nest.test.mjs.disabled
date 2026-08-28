// Nested subagent session tree rendering (steps 1-5 from the original nest.test.mjs).
// Step 6 (real-engine smoke test) is dropped — it requires a live chatserver+engine.
// Port 8166. Embedded fake engine.
//
// Cases:
//   1. auto-open picks the most recent ROOT session, never a subagent
//   2. uncheck "hide subagents" → tree mode with chevrons, kidcount, aggregate dot
//   3. expand → nested child row with badge + indent; persists across reload
//   4. collapse again → aggregate dot returns
//   5. hide checkbox still flattens
//
// Run: node e2e/embedded/nest.test.mjs

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, launchBrowser, screenshot } from '../helpers/setup.mjs';

const PORT = 8166;
const BASE = `http://127.0.0.1:${PORT}`;

// ============================== fake engine =================================

const NOW = Date.now();
const M = 60_000;

const SESSIONS = [
  {
    id: 'ses_root',
    title: 'Root session',
    created: NOW - 90 * M,
    updated: NOW - 10 * M,
    message_count: 12,
    cost: 0,
    model: 'x-preview-f-free',
  },
  {
    id: 'ses_sub',
    title: 'Find stuff (@explore subagent)',
    created: NOW - 5 * M,
    updated: NOW - 1 * M,
    message_count: 2,
    cost: 0,
    model: 'ox-alpha-free',
    parent: 'ses_root',
    agent: 'explore',
  },
  {
    id: 'ses_orph',
    title: 'Orphan task (@general subagent)',
    created: NOW - 40 * M,
    updated: NOW - 20 * M,
    message_count: 3,
    cost: 0,
    model: 'ox-alpha-free',
    parent: 'ses_missing',
    agent: 'general',
  },
  {
    id: 'ses_root2',
    title: 'Second root',
    created: NOW - 80 * M,
    updated: NOW - 30 * M,
    message_count: 5,
    cost: 0,
    model: 'x-preview-f-free',
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

function json(res, obj, code = 200) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length });
  res.end(b);
}

const server = http.createServer(async (req, res) => {
  const p = (req.path_url ??= req.url.split('?')[0]);

  try {
    // ---- SSE ----------------------------------------------------------------
    if (p === '/oc/event') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      req.on('close', () => {});
      return;
    }

    // ---- history -------------------------------------------------------------
    if (p === '/api/history/sessions') return json(res, SESSIONS);
    if (p.endsWith('/errors')) return json(res, []);
    if (p.startsWith('/api/history/session/')) return json(res, []);

    // ---- engine stubs --------------------------------------------------------
    if (p === '/oc/session/status')
      return json(res, { ses_sub: { type: 'busy' } });
    if (p === '/oc/permission') return json(res, []);

    const mMsg = p.match(/^\/oc\/session\/([^/]+)\/message$/);
    if (mMsg && req.method === 'GET') return json(res, []);

    if (p.match(/^\/oc\/session\/[^/]+$/) && req.method === 'GET')
      return json(res, { id: 'ses_root', title: 'Root session', revert: null });
    if (p === '/oc/session' && req.method === 'POST')
      return json(res, { id: 'ses_root', title: 'Root session', revert: null });

    if (p === '/oc/config/providers')
      return json(res, { providers: [{ id: 'opencode', models: {} }] });
    if (p === '/oc/path') return json(res, { directory: '/workspace' });
    if (p === '/oc/mcp') return json(res, {});
    if (p.startsWith('/oc/')) return json(res, []);

    // ---- statics (webui/dist) ------------------------------------------------
    const rel = p === '/' ? '/index.html' : p;
    const full = fs.realpathSync(path.join(DIST, rel));
    if (!full.startsWith(fs.realpathSync(DIST)) || !fs.statSync(full).isFile())
      return json(res, { error: 'missing' }, 404);
    const ct = MIME[path.extname(full)] ?? 'application/octet-stream';
    const b = fs.readFileSync(full);
    res.writeHead(200, { 'Content-Type': ct, 'Content-Length': b.length, 'Cache-Control': 'no-store' });
    res.end(b);
  } catch (e) {
    try { json(res, { error: String(e) }, 500); } catch { /* SSE */ }
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
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));

  try {
    // ---- 1. auto-open picks the most recent ROOT, never the sub ---------------
    console.log('\nCASE 1 — auto-open picks root session');
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForSelector('.tabbar .tab .label', { timeout: 10000 });
    await page.waitForTimeout(800);
    const tabTitle = await page.$eval('.tabbar .tab .label', (el) => el.textContent.trim());
    check('1', 'auto-opened tab is Root session (not sub)', tabTitle === 'Root session', tabTitle);

    // ---- 2. uncheck "hide subagents" → tree mode -----------------------------
    console.log('\nCASE 2 — tree mode');
    await page.uncheck('.hidesub input');
    await page.waitForTimeout(400);

    const section = (await page.$eval('.section .count', (el) => el.textContent)).replace(/\s+/g, ' ').trim();
    check('2', 'section count visible', /\d/.test(section), section);

    const topTitles = await page.$$eval('.list .item > .row1 .title', (els) =>
      els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()),
    );
    check('2', 'top-level rows present', topTitles.length >= 2, `count=${topTitles.length}`);
    check('2', 'orphan is top-level', topTitles.some((t) => t.includes('Orphan task')));

    const chevrons = await page.$$eval('.chev', (els) => els.length);
    check('2', 'chevrons present', chevrons > 0, `count=${chevrons}`);

    const kidcount = await page.$eval('.kidcount', (el) => el.textContent).catch(() => null);
    check('2', 'kidcount chip visible', !!kidcount, kidcount);

    const aggdot = await page.$eval('.aggdot.busy', (el) => getComputedStyle(el).backgroundColor).catch(() => null);
    check('2', 'aggregate busy dot rendered', !!aggdot, aggdot);

    const subVisibleDefault = await page.$$eval('.item.child', (els) => els.length);
    check('2', 'child rows collapsed by default (want 0)', subVisibleDefault === 0);
    await screenshot(page, 'nest-collapsed');

    // ---- 3. expand → nested child row + persistence --------------------------
    console.log('\nCASE 3 — expand + persistence');
    await page.click('.chev');
    await page.waitForTimeout(300);

    const childRow = await page.$eval('.item.child', (el) => ({
      text: el.textContent.replace(/\s+/g, ' ').trim(),
      padLeft: getComputedStyle(el).paddingLeft,
    })).catch(() => null);
    check('3', 'child row visible after expand', !!childRow, childRow?.text?.slice(0, 60));
    check('3', 'child has indentation', childRow ? parseInt(childRow.padLeft) > 0 : false, childRow?.padLeft);

    const stored = await page.evaluate(() => localStorage.getItem('opencode.subExpanded'));
    check('3', 'subExpanded persisted in localStorage', !!stored, stored);

    // reload — expanded state persists
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.item', { timeout: 10000 });
    await page.waitForTimeout(600);
    const childAfterReload = await page.$$eval('.item.child', (els) => els.length);
    check('3', 'child row persists after reload (want 1)', childAfterReload === 1, `got ${childAfterReload}`);

    // ---- 4. collapse again → aggdot returns ----------------------------------
    console.log('\nCASE 4 — collapse');
    await page.click('.chev');
    await page.waitForTimeout(300);
    const childAfterCollapse = await page.$$eval('.item.child', (els) => els.length);
    check('4', 'child rows gone after collapse', childAfterCollapse === 0);
    const aggdotAfter = await page.$eval('.aggdot.busy', (el) => el.title).catch(() => null);
    check('4', 'aggregate dot returns', !!aggdotAfter, aggdotAfter);
    await screenshot(page, 'nest-aggdot');

    // ---- 5. hide checkbox still flattens -------------------------------------
    console.log('\nCASE 5 — hide flattens');
    await page.check('.hidesub input');
    await page.waitForTimeout(300);
    const hiddenChild = await page.$$eval('.item.child', (els) => els.length);
    check('5', 'child rows = 0 in hidden mode', hiddenChild === 0);
    const hiddenChevrons = await page.$$eval('.chev', (els) => els.length);
    check('5', 'chevrons = 0 in hidden mode', hiddenChevrons === 0, `got ${hiddenChevrons}`);
    const sectionHidden = (await page.$eval('.section .count', (el) => el.textContent)).replace(/\s+/g, ' ').trim();
    check('5', 'section shows hidden count', /\d/.test(sectionHidden), sectionHidden);

  } finally {
    await browser.close();
  }
} finally {
  await new Promise((r) => server.close(r));
}

// =============================== summary ====================================

console.log('\n================ SUMMARY ================');
const byCase = {};
for (const r of results) (byCase[r.c] ??= []).push(r);
let fails = 0;
for (const c of Object.keys(byCase)) {
  const ok = byCase[c].every((r) => r.pass);
  console.log(`  Case ${c}: ${ok ? 'PASS' : 'FAIL'} (${byCase[c].filter((r) => r.pass).length}/${byCase[c].length})`);
  fails += byCase[c].filter((r) => !r.pass).length;
}
if (pageErrors.length) {
  console.log(`\npage errors observed (${pageErrors.length}):`);
  for (const e of [...new Set(pageErrors)].slice(0, 5)) console.log('  •', e.slice(0, 220));
}
console.log('\nChecks:', results.length, '| failed:', fails);
process.exitCode = fails ? 1 : 0;
