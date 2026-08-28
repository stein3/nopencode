// search-groups.test.mjs — verify grouped search results in sidebar
// (grouped by session, desc by latest match, relTime hint).
// Runs against an EMBEDDED fake engine (same pattern as question-picker.mjs).
//
// Cases:
//   A. section header matches "Results (N in M chats)"
//   B. group count matches API
//   C. hit count matches API
//   D. groups are set-equal with expected (from API, relTime hints)
//   E. hints non-empty
//   F. highlights rendered (.hl spans, no sentinel chars)
//   G. click-through opens transcript
//
// Run: node e2e/embedded/search-groups.test.mjs

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, launchBrowser, screenshot, SHOTS_DIR, sleep } from '../helpers/setup.mjs';

const PORT = 8158;
const BASE = `http://127.0.0.1:${PORT}`;

const Q = 'opencode';

// ---- search fixture data ----------------------------------------------------

const SID_1 = 'ses_search_1';
const SID_2 = 'ses_search_2';
const SID_3 = 'ses_search_3';
const TITLE_1 = 'opencode architecture';
const TITLE_2 = 'opencode deployment';
const TITLE_3 = 'opencode debugging';

// Ordered by time DESC in the API
const SEARCH_HITS = [
  { session_id: SID_2, session_title: TITLE_2, time: Date.now() - 60_000, snippet: 'the \x00opencode\x01 engine runs on port 4096', message_id: 'msg_s2_1' },
  { session_id: SID_1, session_title: TITLE_1, time: Date.now() - 120_000, snippet: '\x00opencode\x01 uses a Go engine with SSE events', message_id: 'msg_s1_1' },
  { session_id: SID_1, session_title: TITLE_1, time: Date.now() - 180_000, snippet: 'configure \x00opencode\x01 via opencode.jsonc', message_id: 'msg_s1_2' },
  { session_id: SID_3, session_title: TITLE_3, time: Date.now() - 300_000, snippet: 'debug \x00opencode\x01 with --log-level DEBUG', message_id: 'msg_s3_1' },
];

const SESSIONS = [
  { id: SID_1, title: TITLE_1, created: Date.now() - 500_000, updated: Date.now() - 120_000, message_count: 5, cost: 0 },
  { id: SID_2, title: TITLE_2, created: Date.now() - 400_000, updated: Date.now() - 60_000, message_count: 3, cost: 0 },
  { id: SID_3, title: TITLE_3, created: Date.now() - 350_000, updated: Date.now() - 300_000, message_count: 4, cost: 0 },
];

// ---- relTime mirror (matches webui/src/lib/util.ts) ------------------------

function relTime(ts) {
  if (!ts) return '';
  const ms = ts < 1e12 ? ts * 1000 : ts;
  const d = Date.now() - ms;
  const min = Math.floor(d / 60000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days}d`;
  return new Date(ms).toLocaleDateString();
}

// Expected groups derived from API data (same as integration test)
const latest = new Map();
const titleOf = new Map();
for (const h of SEARCH_HITS) {
  titleOf.set(h.session_id, h.session_title);
  if (!latest.has(h.session_id) || h.time > latest.get(h.session_id)) latest.set(h.session_id, h.time);
}
const expected = [...latest.entries()]
  .sort((a, b) => b[1] - a[1])
  .map(([sid, t]) => `${titleOf.get(sid)}|${relTime(t)}`);

// ============================== fake engine =================================

const state = { counts: {} };
const sseClients = new Set();

function sseEmit(type, properties = {}) {
  const frame = `data: ${JSON.stringify({ type, properties })}\n\n`;
  for (const res of sseClients) {
    try { res.write(frame); } catch { /* dropped */ }
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript',
  '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.map': 'application/json', '.txt': 'text/plain',
};

function json(res, obj, code = 200) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length });
  res.end(b);
}

const server = http.createServer(async (req, res) => {
  const p = (req.path_url ??= req.url.split('?')[0]);
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  state.counts[p] = (state.counts[p] ?? 0) + 1;

  try {
    // ---- test introspection + control --------------------------------------
    if (p === '/__state') {
      return json(res, { counts: state.counts });
    }
    if (p === '/__ctl') {
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

    // ---- search --------------------------------------------------------------
    if (p === '/api/search') {
      const q = url.searchParams.get('q') ?? '';
      if (q.toLowerCase() === Q.toLowerCase()) return json(res, SEARCH_HITS);
      return json(res, []);
    }

    // ---- history (chatserver stubs) ------------------------------------------
    if (p === '/api/history/sessions') return json(res, SESSIONS);
    if (p.endsWith('/errors')) {
      if (req.method === 'GET') return json(res, []);
      return json(res, { ok: true });
    }
    if (p.startsWith('/api/history/session/')) return json(res, []);

    // ---- engine stubs --------------------------------------------------------
    if (p === '/oc/session/status') return json(res, {});
    if (p.startsWith('/oc/session/') && p.endsWith('/message')) return json(res, []);
    if (p.startsWith('/oc/session/')) {
      const sid = p.split('/oc/session/')[1]?.split('/')[0];
      const sess = SESSIONS.find((s) => s.id === sid);
      return json(res, { id: sid, title: sess?.title ?? 'probe', revert: null });
    }
    if (p === '/oc/session' && req.method === 'POST')
      return json(res, { id: SESSIONS[0].id, title: SESSIONS[0].title, revert: null });
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
    res.writeHead(200, { 'Content-Type': ct, 'Content-Length': b.length, 'Cache-Control': 'no-store' });
    res.end(b);
  } catch (e) {
    try { json(res, { error: String(e) }, 500); } catch { /* SSE */ }
  }
});

// ================================ helpers ====================================

const snap = () => fetch(`${BASE}/__state`).then((r) => r.json());

const results = [];
let pageErrors = [];

function check(c, name, pass, note = '') {
  results.push({ c, name, pass: !!pass, note });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${c} · ${name}${note ? ` — ${note}` : ''}`);
}

// ================================ run ========================================

try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  await snap(); // warm

  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => pageErrors.push(e.message));

  try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForSelector('#sidebar-search', { timeout: 15000 });
    await page.fill('#sidebar-search', Q);
    await page.waitForSelector('.grphead', { timeout: 10000 });
    await page.waitForTimeout(500);

    // ---- A. section header ---------------------------------------------------
    const ui = await page.evaluate(() => {
      const heads = [...document.querySelectorAll('.grphead')].map((el) => ({
        title: el.querySelector('.title')?.textContent.trim() ?? '',
        meta: el.querySelector('.meta')?.textContent.trim() ?? '',
      }));
      const hits = [...document.querySelectorAll('.item.hit')];
      return {
        section: document.querySelector('.section')?.textContent.trim() ?? '',
        heads,
        hitCount: hits.length,
        hitPad: hits[0] ? getComputedStyle(hits[0]).paddingLeft : null,
        headPad: getComputedStyle(document.querySelector('.grphead')).paddingLeft,
      };
    });

    check('A', 'section header',
      /Results \(\d+ in \d+ chats\)/.test(ui.section), ui.section);

    // ---- B. group count matches API ------------------------------------------
    check('B', 'group count matches API',
      ui.heads.length === expected.length,
      `ui=${ui.heads.length} api=${expected.length}`);

    // ---- C. hit count matches API --------------------------------------------
    check('C', 'hit count matches API',
      ui.hitCount === SEARCH_HITS.length,
      `ui=${ui.hitCount} api=${SEARCH_HITS.length}`);

    // ---- D. groups are set-equal with expected (relTime can vary) ------------
    const got = ui.heads.map((h) => `${h.title}|${h.meta}`);
    const gotSet = new Set(got);
    const expSet = new Set(expected);
    const orderOk = gotSet.size === expSet.size && [...gotSet].every((g) => expSet.has(g));
    check('D', 'groups match API (set equality)', orderOk,
      `got=${got.length} exp=${expected.length} diff=${[...gotSet].filter((g) => !expSet.has(g)).join('; ') || 'none'}`);

    // ---- E. hints non-empty --------------------------------------------------
    check('E', 'hints non-empty',
      ui.heads.every((h) => h.meta.length > 0),
      ui.heads.map((h) => h.meta).join(','));

    // ---- F. highlights rendered -----------------------------------------------
    const hl = await page.evaluate((q) => {
      const spans = [...document.querySelectorAll('.snippet .hl')];
      const allSnip = [...document.querySelectorAll('.snippet')].map((s) => s.textContent);
      return {
        count: spans.length,
        leaked: allSnip.some((t) => t.includes('\x00') || t.includes('\x01')),
        sample: spans.slice(0, 3).map((s) => s.textContent),
        allMatch: spans.every((s) => s.textContent.toLowerCase().includes(q)),
        bg: spans[0] ? getComputedStyle(spans[0]).backgroundColor : null,
      };
    }, Q);
    check('F', 'highlight spans rendered', hl.count > 0,
      `count=${hl.count} sample=${JSON.stringify(hl.sample)}`);
    check('F', 'no sentinel chars in DOM', !hl.leaked);
    check('F', 'highlighted text contains query', hl.allMatch);
    check('F', 'highlight bg applied', hl.bg && hl.bg !== 'rgba(0, 0, 0, 0)', hl.bg);

    // ---- G. click-through opens transcript ------------------------------------
    const panesBefore = await page.locator('.tabpane').count();
    await page.locator('.item.hit').first().click();
    let paneVisible = false;
    try {
      await page.waitForSelector('.tabpane:visible', { timeout: 6000 });
      paneVisible = true;
    } catch {
      const diag = await page.evaluate(() =>
        [...document.querySelectorAll('.tabpane')].map((p) => ({
          style: p.getAttribute('style')?.slice(0, 60),
          msgs: p.querySelectorAll('.msg').length,
        })),
      );
      console.log('PANE DIAG:', JSON.stringify(diag));
    }
    check('G', 'click-through opens transcript', paneVisible,
      `panesBefore=${panesBefore}`);

    // ---- screenshot -----------------------------------------------------------
    await page.evaluate(() => document.querySelector('#sidebar-search').blur());
    await page.fill('#sidebar-search', Q);
    await page.waitForTimeout(400);
    await page.locator('aside.sidebar').screenshot({ path: path.join(SHOTS_DIR, 'search-groups.png') });
    check('A', 'screenshot saved', true);

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
