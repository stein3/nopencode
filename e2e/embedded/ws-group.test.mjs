// ws-group.test.mjs — the sidebar's "group by workspace" checkbox.
//
// Self-contained embedded test (same pattern as subs.test.mjs): serves
// webui/dist + a stub engine/history + SSE, no live chatserver or engine.
//
// The sidebar groups chats under collapsible workspace (cwd) headers. The
// checkbox in the section header opts out; ordering rules are unit-checked
// browser-free in session-grouping.test.mjs, so this file only proves the real
// wiring: the control exists, drives the DOM, persists, and disappears when the
// backend gives no cwd at all (a plain opencode engine must keep the old flat
// list with no dead UI).
//
// Checks:
//   A  default: checkbox present + checked, one .wshead per workspace, labelled
//      by the directory basename, rows bucketed under their workspace
//   B  uncheck -> headers gone and rows fall back to global updated-desc order
//      (a DIFFERENT order than grouped: that is what proves the toggle works)
//   C  persists across reload (localStorage opencode.groupByWorkspace)
//   D  re-check restores headers; collapse on a header still hides its rows
//   E  backend with no cwd -> checkbox absent, no headers, list intact, and
//      the "hide subagents" checkbox is untouched
//   F  layout: the two toggles coexist in the section header without overlap or
//      clipping, and wrap instead of overflowing in a 200px-wide sidebar
//
// Run: node e2e/embedded/ws-group.test.mjs

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, launchBrowser, screenshot, sleep, SHOTS_DIR } from '../helpers/setup.mjs';

const PORT = 8177;
const BASE = `http://127.0.0.1:${PORT}`;

// ============================== fixtures ====================================

const NOW = Date.now();

// Two workspaces, INTERLEAVED in updated-desc order (the sidebar's input
// order), so grouped order (C,A,B) differs from flat order (C,B,A).
const WS_SESSIONS = [
  { id: 'ses_c', title: 'CCC alpha recent', created: NOW - 120_000, updated: NOW - 80_000, message_count: 2, cost: 0, cwd: '/work/alpha' },
  { id: 'ses_b', title: 'BBB beta mid',     created: NOW - 110_000, updated: NOW - 90_000, message_count: 1, cost: 0, cwd: '/work/beta' },
  { id: 'ses_a', title: 'AAA alpha old',    created: NOW - 100_000, updated: NOW - 100_000, message_count: 3, cost: 0, cwd: '/work/alpha' },
];

// A backend that never reports a workspace (engine without cwd projection).
const NOWS_SESSIONS = WS_SESSIONS.map(({ cwd, ...rest }) => ({ ...rest }));

let fixture = WS_SESSIONS;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/x-icon',
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
    // ---- fixture switch (POST /__ctl {"fixture":"nows"|"ws"}) ---------------
    if (p === '/__ctl' && req.method === 'POST') {
      const body = await new Promise((r) => {
        let s = '';
        req.on('data', (c) => (s += c));
        req.on('end', () => r(s));
      });
      let want = '';
      try { want = JSON.parse(body || '{}').fixture || ''; } catch { /* ignore */ }
      fixture = want === 'nows' ? NOWS_SESSIONS : WS_SESSIONS;
      return json(res, { ok: true, fixture: want || 'ws' });
    }

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

    // ---- history (what the sidebar list reads) ------------------------------
    if (p === '/api/history/sessions') return json(res, fixture);
    if (p.endsWith('/errors')) return json(res, []);
    if (p.startsWith('/api/history/session/')) return json(res, []);

    // ---- engine stubs -------------------------------------------------------
    if (p === '/oc/session/status') return json(res, {});
    if (p === '/oc/permission') return json(res, []);
    if (p.match(/^\/oc\/session\/[^/]+\/message$/) && req.method === 'GET') return json(res, []);
    if (p.match(/^\/oc\/session\/[^/]+$/) && req.method === 'GET')
      return json(res, { id: 'ses_c', title: 'CCC alpha recent', revert: null });
    if (p === '/oc/session' && req.method === 'POST')
      return json(res, { id: 'ses_c', title: 'CCC alpha recent', revert: null });
    if (p === '/oc/config/providers')
      return json(res, { providers: [{ id: 'opencode', models: {} }] });
    if (p === '/oc/path') return json(res, { directory: '/work/alpha' });
    if (p === '/oc/mcp') return json(res, {});
    if (p.startsWith('/oc/')) return json(res, []);

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
    try { json(res, { error: String(e) }, 500); } catch { /* SSE */ }
  }
});

// ================================ checks ====================================

const results = [];
const pageErrors = [];

function check(c, name, pass, note = '') {
  results.push({ c, name, pass: !!pass, note });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${c} · ${name}${note ? ` — ${note}` : ''}`);
}

// row titles in DOM order, reduced to their unique AAA/BBB/CCC marker
const rowOrder = (page) =>
  page.$$eval('.sidebar .item .ttext', (els) =>
    els.map((e) => (e.textContent || '').trim().match(/AAA|BBB|CCC/)?.[0]).filter(Boolean),
  );
const wsNames = (page) =>
  page.$$eval('.sidebar .wshead .wsname', (els) => els.map((e) => (e.textContent || '').trim()));
const wsTitles = (page) =>
  page.$$eval('.sidebar .wshead', (els) => els.map((e) => e.getAttribute('title') || ''));

// the checkbox is the feature under test: every read of it must degrade to a
// FAIL line, not a playwright exception, when a build has no such control
// (that is what a pre-fix dist looks like — see the red run in e2e/README)
const boxChecked = (page) => page.$eval('.wsgrp input', (el) => el.checked).catch(() => null);
const boxText = (page) =>
  page.$eval('.wsgrp', (el) => (el.textContent || '').trim()).catch(() => '');
async function setGrouping(page, want) {
  if (!(await page.$('.wsgrp input'))) return false;
  await (want ? page.check('.wsgrp input') : page.uncheck('.wsgrp input'));
  await sleep(500);
  return true;
}

// ================================ run =======================================

try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => pageErrors.push(e.message));

  try {
let shotOn = null;   // Case A pixels, kept for the rendered-difference check

    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForSelector('.sidebar .item', { timeout: 10000 });
    await sleep(700);

    // ---- Case A: default = grouped -----------------------------------------
    console.log('\nCASE A — default: workspace headers + checkbox on');

    check('A', 'wsgrp checkbox exists', !!(await page.$('.wsgrp input')));
    check('A', 'default: checkbox is checked', (await boxChecked(page)) === true);
    check('A', 'label reads "group by workspace"', /group by workspace/i.test(await boxText(page)), await boxText(page));

    const names = await wsNames(page);
    check('A', 'one header per workspace, basename label, first-appearance order',
      JSON.stringify(names) === '["alpha","beta"]', JSON.stringify(names));
    const titles = await wsTitles(page);
    check('A', 'header title attribute carries the full cwd',
      JSON.stringify(titles) === '["/work/alpha","/work/beta"]', JSON.stringify(titles));

    let order = await rowOrder(page);
    check('A', 'grouped row order is bucketed (CCC,AAA,BBB)',
      JSON.stringify(order) === '["CCC","AAA","BBB"]', JSON.stringify(order));
    check('A', 'all 3 rows still listed', order.length === 3, `got ${order.length}`);
    // Raw buffers, not screenshot(): case B compares the two shots byte-wise
    // (shotOn.equals(shotOff)), so both must come from the same call shape. That
    // means writing into SHOTS_DIR directly — which needs the directory to exist.
    // shots/ is git-ignored, so a fresh CI checkout has none and these writes threw
    // ENOENT after every DOM check had passed; helpers/setup.mjs now creates
    // SHOTS_DIR at import so this no longer depends on another test running first.
    shotOn = await page.screenshot();
    fs.writeFileSync(path.join(SHOTS_DIR, 'ws-group-on.png'), shotOn);

    // ---- Case B: uncheck -> flat, different order --------------------------
    console.log('\nCASE B — uncheck: no headers, flat updated-desc order');

    check('B', 'checkbox still there', await setGrouping(page, false));
    check('B', 'headers removed', (await page.$$('.sidebar .wshead')).length === 0);
    order = await rowOrder(page);
    check('B', 'flat order is global updated-desc (CCC,BBB,AAA)',
      JSON.stringify(order) === '["CCC","BBB","AAA"]', JSON.stringify(order));
    check('B', 'no row lost by ungrouping', order.length === 3, `got ${order.length}`);
    // pixels must move too: DOM assertions alone would pass on an unstyled or
    // invisible change. (This check is what caught two byte-identical shots.)
    const shotOff = await page.screenshot();
    fs.writeFileSync(path.join(SHOTS_DIR, 'ws-group-off.png'), shotOff);
    check('B', 'grouping off changes rendered pixels', !!shotOn && !shotOn.equals(shotOff),
      `shot bytes on/off = ${shotOn?.length}/${shotOff?.length}${shotOn && shotOff && shotOn.equals(shotOff) ? ' IDENTICAL' : ''}`);
    const stored = await page.evaluate(() => localStorage.getItem('opencode.groupByWorkspace'));
    check('B', 'localStorage persisted off', stored === '0' || stored === 'false', `stored=${stored}`);
    await screenshot(page, 'ws-group-off');

    // ---- Case C: persistence across reload ---------------------------------
    console.log('\nCASE C — reload keeps the choice');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sidebar .item', { timeout: 10000 });
    await sleep(700);
    check('C', 'checkbox still unchecked after reload', (await boxChecked(page)) === false);
    check('C', 'still ungrouped after reload', (await page.$$('.sidebar .wshead')).length === 0);
    order = await rowOrder(page);
    check('C', 'flat order after reload',
      JSON.stringify(order) === '["CCC","BBB","AAA"]', JSON.stringify(order));

    // ---- Case D: re-check restores groups; collapse still works ------------
    console.log('\nCASE D — re-check restores headers, collapse unaffected');

    check('D', 'checkbox togglable back on', await setGrouping(page, true));
    check('D', 'headers return', (await page.$$('.sidebar .wshead')).length === 2);
    order = await rowOrder(page);
    check('D', 'grouped order restored',
      JSON.stringify(order) === '["CCC","AAA","BBB"]', JSON.stringify(order));

    await page.click('.sidebar .wshead'); // collapse /work/alpha
    await sleep(400);
    order = await rowOrder(page);
    check('D', 'collapsing a workspace header hides its rows',
      JSON.stringify(order) === '["BBB"]', JSON.stringify(order));
    await page.click('.sidebar .wshead');
    await sleep(400);
    order = await rowOrder(page);
    check('D', 'expanding it brings them back',
      JSON.stringify(order) === '["CCC","AAA","BBB"]', JSON.stringify(order));

    // ---- Case E: backend with no cwd -> no checkbox, no headers ------------
    console.log('\nCASE E — backend without cwd: flat list, checkbox hidden');

    await fetch(`${BASE}/__ctl`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fixture: 'nows' }),
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sidebar .item', { timeout: 10000 });
    await sleep(700);

    check('E', 'group-by checkbox hidden when no session has a workspace',
      !(await page.$('.wsgrp')));
    check('E', 'no workspace headers', (await page.$$('.sidebar .wshead')).length === 0);
    order = await rowOrder(page);
    check('E', 'list intact and flat', JSON.stringify(order) === '["CCC","BBB","AAA"]', JSON.stringify(order));
    check('E', 'hide-subagents checkbox untouched', !!(await page.$('.hidesub input')));
    const hc = await page.$eval('.hidesub input', (el) => el.checked);
    check('E', 'hide-subagents still defaulted on', hc);
    await screenshot(page, 'ws-group-none');

    // ---- Case F: both toggles share the header row --------------------------
    console.log('\nCASE F — layout: hide-subagents + group-by-workspace coexist');

    // back to the two-workspace fixture, where the checkbox exists
    await fetch(`${BASE}/__ctl`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fixture: 'ws' }),
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.wsgrp input', { timeout: 10000 }).catch(() => {});
    await sleep(600);
    check('F', 'checkbox present for the layout checks', !!(await page.$('.wsgrp input')));

    const box = await page.evaluate(() => {
      const r = (e) => { const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
      const g = document.querySelector('.wsgrp'), h = document.querySelector('.hidesub'), s = document.querySelector('.section');
      if (!g || !h || !s) return null;
      return { g: r(g), h: r(h), ov: s.scrollWidth - s.clientWidth };
    });
    check('F', 'both toggles render with real size',
      !!box && box.g.w > 20 && box.g.h > 10 && box.h.w > 20, JSON.stringify(box));
    const xOverlap = box && box.g.x + box.g.w > box.h.x + 0.5 && box.h.x + box.h.w > box.g.x + 0.5;
    const yOverlap = box && box.g.y + box.g.h > box.h.y + 0.5 && box.h.y + box.h.h > box.g.y + 0.5;
    check('F', 'the two labels do not overlap', !(xOverlap && yOverlap), JSON.stringify(box));
    check('F', 'header row has no horizontal overflow @1280px', box && box.ov === 0, box ? `overflow=${box.ov}` : 'no header row');

    // narrow sidebar (drag handle can get this tight): must wrap, not clip
    await page.evaluate(() => { document.querySelector('aside.sidebar').style.width = '200px'; });
    await sleep(400);
    const narrow = await page.evaluate(() => {
      const s = document.querySelector('.section'), g = document.querySelector('.wsgrp');
      if (!s || !g) return null;
      const b = g.getBoundingClientRect();
      return { ov: s.scrollWidth - s.clientWidth, w: Math.round(b.width), vis: b.height > 10 };
    });
    check('F', 'wraps instead of clipping in a 200px sidebar',
      !!narrow && narrow.ov <= 0 && narrow.vis && narrow.w > 20, JSON.stringify(narrow));
    await screenshot(page, 'ws-group-narrow');
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
