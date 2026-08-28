// verify-hidelight.mjs — Fix B regression: with "hide subagents" ON, parent
// rows used to lose ALL subagent indication (displayRows mapped every row
// through flat() → kids:0/agg zeroed → neither {#if d.kids} block rendered).
// Now hidden mode still flattens to aggregate descendant status and flags root
// rows subsHidden — the aggregated LIGHT stays (perm > ask > busy > unread),
// the count chip, chevron and sub rows stay gone.
//
// Self-contained: embedded server serves webui/dist + fixture endpoints (same
// pattern as verify-question.mjs) — no live engine/chatserver needed.
//
// Checks:
//   H1 default (hide ON): parent row shows .aggdot.busy + .kidcount ("3
//      subagents · hidden"), NO .chev, no .sub-row/.item.child anywhere;
//      header keeps "· N hidden"
//   H2 light independent of persisted expand state (subExpanded seeded)
//   H3 toggle OFF → previous behavior intact: count "3", chevron, collapsed
//      aggdot; expand → 3 sub rows + light hides; collapse → light returns
//   H4 toggle ON again in place → light returns, chevron/sub rows vanish
//      (count chip STAYS — always visible since the 2026-08 layout pass)
//   H5 live re-aggregation: engine busy→idle flip surfaces as the unread
//      light via the real 10s busy-poll diff (non-open session path)
//
// Run: node e2e/embedded/hidelight.test.mjs
// Shots: .webtest/shots/hidelight-*.png

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, launchBrowser, sleep, poll, SHOTS_DIR } from '../helpers/setup.mjs';

const PORT = 8132;
const BASE = `http://127.0.0.1:${PORT}`;

// ============================== fixtures ====================================

const NOW = Date.now();
const M = 60000;
const SESSIONS = [
  {
    id: 'ses_p',
    title: 'Parent orchestration session',
    created: NOW - 90 * M,
    updated: NOW - 1 * M,
    message_count: 12,
    cost: 0,
    model: 'x-preview-f-free',
  },
  {
    id: 'ses_s1',
    title: 'Explore codebase (@explore subagent)',
    created: NOW - 9 * M,
    updated: NOW - 5 * M,
    message_count: 3,
    cost: 0,
    model: 'ox-alpha-free',
    parent: 'ses_p',
    agent: 'explore',
  },
  {
    id: 'ses_s2',
    title: 'General refactor (@general subagent)',
    created: NOW - 8 * M,
    updated: NOW - 4 * M,
    message_count: 2,
    cost: 0,
    model: 'ox-alpha-free',
    parent: 'ses_p',
    agent: 'general',
  },
  {
    id: 'ses_s3',
    title: 'Second explore pass (@explore subagent)',
    created: NOW - 7 * M,
    updated: NOW - 3 * M,
    message_count: 2,
    cost: 0,
    model: 'ox-alpha-free',
    parent: 'ses_p',
    agent: 'explore',
  },
];
let STATUS = { ses_s1: { type: 'busy' } }; // mutable via /__ctl

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
};
const json = (res, obj, code = 200) => {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length });
  res.end(b);
};

const server = http.createServer(async (req, res) => {
  const p = req.url.split('?')[0];
  try {
    if (p === '/__ctl') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (body.status) STATUS = body.status;
      return json(res, { ok: true });
    }
    if (p === '/api/history/sessions') return json(res, SESSIONS);
    if (p.startsWith('/api/history/session/')) return json(res, []);
    if (p === '/oc/event') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      return; // stays open
    }
    if (p === '/oc/session/status') return json(res, STATUS);
    if (p === '/oc/permission' || p === '/oc/question') return json(res, []);
    if (p.startsWith('/oc/session/') && p.endsWith('/message')) return json(res, []);
    if (p.startsWith('/oc/session/'))
      return json(res, { id: 'ses_p', title: 'Parent orchestration session', revert: null });
    if (p === '/oc/config/providers')
      return json(res, {
        providers: [{ id: 'opencode', models: { 'x-preview-f-free': { id: 'x-preview-f-free' } } }],
      });
    if (p === '/oc/path') return json(res, { directory: '/workspace' });
    if (p === '/oc/mcp') return json(res, {});
    if (p.startsWith('/oc/')) return json(res, []);

    // ---- statics (webui/dist) ----
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
    try {
      json(res, { error: String(e) }, 500);
    } catch {}
  }
});
function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => resolve(d));
  });
}

// ================================ checks ====================================

const results = [];
let pageErrors = [];

function check(c, name, pass, note = '') {
  results.push({ c, name, pass: !!pass, note });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${c} · ${name}${note ? ` — ${note}` : ''}`);
}

const rowLoc = async (page) =>
  page.$('.sidebar .item[title="Parent orchestration session"]');

// hide-mode assertions shared by H1/H2/H4
async function expectHiddenMode(page, tag) {
  const row = await rowLoc(page);
  check(tag, 'parent row rendered', row !== null);
  check(tag, 'aggdot.busy shown', (await row.$('.aggdot.busy')) !== null);
  const kc = await row.$eval('.kidcount', (el) => el.textContent.trim()).catch(() => null);
  check(tag, 'kidcount shown (always visible)', kc === '3', `text=${kc}`);
  check(
    tag,
    'kidcount tooltip says hidden',
    (await row.$eval('.kidcount', (el) => el.title).catch(() => '')) === '3 subagents · hidden',
  );
  check(tag, 'chevron NOT shown', (await row.$('.chev')) === null);
  check(
    tag,
    'no sub rows anywhere',
    (await page.$$eval('.item.child, .sub-row', (els) => els.length)) === 0,
  );
  const sec = await page.$eval('.section .count', (el) => el.textContent.replace(/\s+/g, ' ').trim());
  check(tag, 'header keeps hidden count', sec.includes('· 3 hidden'), sec);
}

// ================================ run =======================================

const browser = await launchBrowser();

try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));

  // ---- H1: fresh profile → default hideSubagents=true ----------------------
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('.sidebar .item', { timeout: 10000 });
  await sleep(700);
  check(
    'H1',
    'checkbox defaults to checked',
    await page.$eval('.hidesub input', (el) => el.checked),
  );
  await expectHiddenMode(page, 'H1');
  await page.locator('.sidebar').screenshot({ path: path.join(SHOTS_DIR, 'hidelight-hidden.png') });

  // ---- H2: persisted expand state must not matter in hide mode -------------
  await page.evaluate(() => {
    localStorage.setItem('opencode.subExpanded', JSON.stringify(['ses_p']));
    localStorage.setItem('opencode.hideSubagents', '1');
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sidebar .item', { timeout: 10000 });
  await sleep(600);
  await expectHiddenMode(page, 'H2');

  // ---- H3: toggle OFF → previous tree behavior intact ----------------------
  await page.evaluate(() => {
    localStorage.setItem('opencode.hideSubagents', '0');
    localStorage.removeItem('opencode.subExpanded'); // start collapsed
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sidebar .item', { timeout: 10000 });
  await sleep(600);
  const row = await rowLoc(page);
  check(
    'H3',
    'collapsed kidcount reads 3',
    (await row.$eval('.kidcount', (el) => el.textContent.trim()).catch(() => null)) === '3',
  );
  check(
    'H3',
    'kidcount tooltip (tree mode, not hidden)',
    (await row.$eval('.kidcount', (el) => el.title).catch(() => '')) === '3 subagents',
  );
  check('H3', 'chevron shown when expanded-set empty', (await row.$('.chev')) !== null);
  check('H3', 'collapsed aggdot.busy shown', (await row.$('.aggdot.busy')) !== null);

  await page.click('.chev');
  await sleep(350);
  check('H3', 'expand reveals 3 sub rows', (await page.$$eval('.item.child', (els) => els.length)) === 3);
  check('H3', 'expanded parent hides aggdot', (await row.$('.aggdot')) === null);
  await page.locator('.sidebar').screenshot({ path: path.join(SHOTS_DIR, 'hidelight-tree-expanded.png') });

  await page.click('.chev');
  await sleep(350);
  check('H3', 'collapse removes sub rows', (await page.$$eval('.item.child', (els) => els.length)) === 0);
  check('H3', 'collapse restores aggdot.busy', (await row.$('.aggdot.busy')) !== null);

  // ---- H4: toggle ON in place → light returns, chev/sub rows vanish -------
  await page.check('.hidesub input');
  await sleep(400);
  await expectHiddenMode(page, 'H4');

  // ---- H5: live re-aggregation via the real 10s busy-poll diff -------------
  // ses_s1 goes idle while its tab is NOT open → refreshBusy marks it unread →
  // the aggregated light flips yellow(busy) → accent(unread)
  await fetch(`${BASE}/__ctl`, {
    method: 'POST',
    body: JSON.stringify({ status: {} }),
  }).then((r) => r.json());
  const flipped = await poll(async () => (await row.$('.aggdot.unread')) !== null, 13000);
  check('H5', 'busy→idle flips light to unread within one poll', flipped);
  check('H5', 'old busy light gone', (await row.$('.aggdot.busy')) === null);
  await page.locator('.sidebar').screenshot({ path: path.join(SHOTS_DIR, 'hidelight-unread.png') });

  await ctx.close();
} finally {
  await browser.close();
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
