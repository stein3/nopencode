// verify-titleclip.mjs — Fix A regression: a long session title used to be a
// bare anonymous flex item inside .title, so its min-content width consumed
// the whole row and the trailing .kidcount badge / .aggdot light were
// hard-clipped by .title's overflow:hidden (no ellipsis painted either).
// The title text now lives in .ttext (min-width:0 + ellipsis) and absorbs the
// overflow; dot/chev/badge/light always stay visible. The row timestamp got
// flex:none (.row1 .meta) so it never shrinks either.
//
// Self-contained: embedded server serves webui/dist + fixture endpoints (same
// pattern as verify-question.mjs) — no live engine/chatserver needed.
//
// Checks:
//   T1 tree mode (hide OFF, collapsed parent): .kidcount + .aggdot.busy exist
//      and their boxes lie FULLY INSIDE .title's clip box and the sidebar;
//      aggdot sits on LINE 1 immediately LEFT of the count chip (2026-08
//      layout pass — was the line-2 gutter before);
//      .ttext ellipsizes (scrollWidth > clientWidth, text-overflow:ellipsis)
//   T2 same row in hide mode (hide ON): light + count chip still inside bounds,
//      title still ellipsizes, no .chev / sub rows rendered
//
// Run: node e2e/embedded/titleclip.test.mjs
// Shots: .webtest/shots/titleclip-{tree,hidden}.png

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, launchBrowser, sleep, SHOTS_DIR } from '../helpers/setup.mjs';

const PORT = 8131;
const BASE = `http://127.0.0.1:${PORT}`;

// ============================== fixtures ====================================

const NOW = Date.now();
const M = 60000;
// ~170 chars — far wider than the 260–320px sidebar can ever show
const LONG_TITLE =
  'Investigate flaky integration test in the payment retry pipeline and document ' +
  'reproduction steps for the on-call rotation handbook before the Friday cut';
const SESSIONS = [
  {
    id: 'ses_long',
    title: LONG_TITLE,
    created: NOW - 90 * M,
    updated: NOW - 2 * M,
    message_count: 9,
    cost: 0,
    model: 'x-preview-f-free',
  },
  {
    id: 'ses_lsub1',
    title: 'Scanning test files (@explore subagent)',
    created: NOW - 9 * M,
    updated: NOW - 4 * M,
    message_count: 2,
    cost: 0,
    model: 'ox-alpha-free',
    parent: 'ses_long',
    agent: 'explore',
  },
  {
    id: 'ses_lsub2',
    title: 'Rerunning suite (@general subagent)',
    created: NOW - 8 * M,
    updated: NOW - 3 * M,
    message_count: 2,
    cost: 0,
    model: 'ox-alpha-free',
    parent: 'ses_long',
    agent: 'general',
  },
];
const STATUS = { ses_lsub1: { type: 'busy' } }; // collapsed parent → aggdot.busy

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

const server = http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  try {
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
    if (p.startsWith('/oc/session/')) return json(res, { id: 'ses_long', title: LONG_TITLE, revert: null });
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

// ================================ checks ====================================

const results = [];
let pageErrors = [];

function check(c, name, pass, note = '') {
  results.push({ c, name, pass: !!pass, note });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${c} · ${name}${note ? ` — ${note}` : ''}`);
}

// geometry of an element inside the page
const box = (handle, sel) =>
  handle.$eval(sel, (el) => {
    const r = el.getBoundingClientRect();
    return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width };
  });

// badge/light must sit fully inside the clip owner (.title) AND the sidebar
async function insideClip(row, sidebarBox, sel, label) {
  const tb = await box(row, '.title');
  const b = await box(row, sel);
  const inTitle = b.l >= tb.l - 0.6 && b.r <= tb.r + 0.6 && b.t >= tb.t - 0.6 && b.b <= tb.b + 0.6;
  const inSide = b.r <= sidebarBox.r - 0.5 && b.l >= sidebarBox.l;
  check(label, 'inside .title clip box', inTitle, JSON.stringify(b));
  check(label, 'inside visible sidebar', inSide, `badge.r=${b.r.toFixed(1)} side.r=${sidebarBox.r.toFixed(1)}`);
}

// aggregate light must sit fully inside the line-1 clip owner (.title) AND the
// sidebar (2026-08 layout pass: inline on line 1, before the count chip)
async function insideGutter(row, sidebarBox, sel, label) {
  const tb = await box(row, '.title');
  const b = await box(row, sel);
  const inTitle = b.l >= tb.l - 0.6 && b.r <= tb.r + 0.6 && b.t >= tb.t - 0.6 && b.b <= tb.b + 0.6;
  const inSide = b.r <= sidebarBox.r - 0.5 && b.l >= sidebarBox.l;
  check(label, 'inside .title clip box', inTitle, JSON.stringify(b));
  check(label, 'inside visible sidebar', inSide, `badge.r=${b.r.toFixed(1)} side.r=${sidebarBox.r.toFixed(1)}`);
}

async function ttextEllipsizes(row, label) {
  const s = await row.$eval('.ttext', (el) => ({
    sw: el.scrollWidth,
    cw: el.clientWidth,
    to: getComputedStyle(el).textOverflow,
    ow: getComputedStyle(el).overflow,
    minw: getComputedStyle(el).minWidth,
  }));
  check(label, '.ttext overflows (scrollWidth > clientWidth)', s.sw > s.cw, `sw=${s.sw} cw=${s.cw}`);
  check(label, '.ttext paints ellipsis', s.to === 'ellipsis' && s.ow === 'hidden', JSON.stringify(s));
  check(label, '.ttext actually shrank (not zero-width)', s.cw > 40, `cw=${s.cw}`);
}

// ================================ run =======================================

const browser = await launchBrowser();

try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('.sidebar .item', { timeout: 10000 });
  await sleep(600);

  // ---- T1: tree mode, long-title parent collapsed --------------------------
  await page.evaluate(() => localStorage.setItem('opencode.hideSubagents', '0'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sidebar .item', { timeout: 10000 });
  await sleep(600);

  const row = await page.$('.sidebar .item[title^="Investigate flaky"]');
  check('T1', 'long-title row rendered', row !== null);
  const sideBox = await page.$eval('.sidebar', (el) => {
    const r = el.getBoundingClientRect();
    return { l: r.left, r: r.right, t: r.top, b: r.bottom };
  });

  check('T1', 'kidcount present in tree mode', (await row.$('.kidcount')) !== null);
  check('T1', 'kidcount reads 2', (await row.$eval('.kidcount', (el) => el.textContent.trim())) === '2');
  check('T1', 'aggdot.busy present in tree mode', (await row.$('.aggdot.busy')) !== null);
  await insideClip(row, sideBox, '.kidcount', 'T1 kidcount');
  await insideGutter(row, sideBox, '.aggdot.busy', 'T1 aggdot');
  await ttextEllipsizes(row, 'T1');

  // 2026-08 line-1 order: chev < dot < title < count (aggdot lives in line 2 now)
  const geo = await row.$eval('.row1', (el) => {
    const bx = (sel) => {
      const n = el.querySelector(sel);
      return n ? n.getBoundingClientRect() : null;
    };
    return { chev: bx('.chev') || bx('.chevslot'), dot: bx('.dot'), tt: bx('.ttext'), kc: bx('.kidcount') };
  });
  const horiz = [geo.chev.left, geo.dot.left, geo.tt.left, geo.kc.left];
  const hsorted = [...horiz].sort((a, b) => a - b);
  check('T1', 'line-1 order chev<dot<title<count', horiz.every((l, i) => Math.abs(l - hsorted[i]) < 0.6), JSON.stringify(geo));

  // 2026-08 layout pass: aggregate light is INLINE on LINE 1 — immediately
  // LEFT of the count chip, vertically fully inside the title row
  const light = await row.evaluate((el) => {
    const bb = (sel) => {
      const n = el.querySelector(sel);
      return n ? n.getBoundingClientRect() : null;
    };
    return { dot: bb('.dot'), agg: bb('.aggdot'), kc: bb('.kidcount'), row1: bb('.row1') };
  });
  check(
    'T1',
    'aggdot fully inside line 1 (.row1)',
    light.agg !== null && light.agg.top >= light.row1.top - 0.6 && light.agg.bottom <= light.row1.bottom + 0.6,
    JSON.stringify(light),
  );
  check(
    'T1',
    'aggdot sits LEFT of kidcount',
    light.agg !== null && light.kc !== null && light.agg.right <= light.kc.left + 0.6,
    JSON.stringify(light),
  );

  // 2026-08 column alignment: meta starts at title x; #subs right edge == time right edge
  const cols = await row.$eval('.ttext', (t) => {
    const it = t.closest('.item');
    const g = (sel) => it.querySelector(sel);
    return {
      tl: t.getBoundingClientRect().left,
      ml: g('.smeta') ? g('.smeta').getBoundingClientRect().left : null,
      kr: g('.kidcount') ? g('.kidcount').getBoundingClientRect().right : null,
      sr: g('.stime') ? g('.stime').getBoundingClientRect().right : null,
    };
  });
  check('T1', 'meta left == title left', cols.ml !== null && Math.abs(cols.ml - cols.tl) < 1.5, JSON.stringify(cols));
  check('T1', '#subs right == time right', cols.kr !== null && Math.abs(cols.kr - cols.sr) < 1.5, JSON.stringify(cols));

  // timestamp never shrinks — lives at the END of line 2 (.sub), stays visible
  const mrow = await row.$eval('.stime', (el) => {
    const r = el.getBoundingClientRect();
    const p = el.closest('.sub').getBoundingClientRect();
    return { mr: r.right, pr: p.right, mw: r.width };
  });
  check('T1', '.stime inside .sub (flex:none held)', mrow.mr <= mrow.pr + 0.6 && mrow.mw > 10, JSON.stringify(mrow));

  await page.locator('.sidebar').screenshot({ path: path.join(SHOTS_DIR, 'titleclip-tree.png') });

  // ---- T2: hide mode — light + count chip survive, chevron doesn't ---------
  await page.check('.hidesub input');
  await sleep(400);
  check('T2', 'aggdot.busy still present', (await row.$('.aggdot.busy')) !== null);
  check('T2', 'kidcount still present', (await row.$('.kidcount')) !== null);
  check(
    'T2',
    'kidcount tooltip says hidden',
    (await row.$eval('.kidcount', (el) => el.title)) === '2 subagents · hidden',
  );
  check('T2', 'chevron gone', (await row.$('.chev')) === null);
  check('T2', 'no sub rows anywhere', (await page.$$eval('.item.child, .sub-row', (els) => els.length)) === 0);
  await insideGutter(row, sideBox, '.aggdot.busy', 'T2 aggdot');
  await ttextEllipsizes(row, 'T2');

  // flat mode reclaims the reserved chevron column — title shifts LEFT vs tree mode
  const flat = await row.evaluate((el) => ({
    tx: el.querySelector('.ttext').getBoundingClientRect().left,
    mx: el.querySelector('.smeta').getBoundingClientRect().left,
  }));
  check('T2', 'chevron column reclaimed (title moved left)', flat.tx < cols.tl - 15, `tree=${cols.tl.toFixed(1)} flat=${flat.tx.toFixed(1)}`);
  check('T2', 'meta still aligned with title', Math.abs(flat.mx - flat.tx) < 1.5, JSON.stringify(flat));

  await page.locator('.sidebar').screenshot({ path: path.join(SHOTS_DIR, 'titleclip-hidden.png') });

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
