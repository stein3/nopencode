// backfill-scroll.test.mjs — regression: scrolling DOWN while the older-history
// backfill is in flight must not teleport the reader.
//
// Root cause (fixed in Transcript.svelte): maybeLoadOlder freezes
// `anchorFromBottom = scrollHeight - scrollTop` at trigger time, then
// afterUpdate restores `scrollTop = scrollHeight - anchorFromBottom` after the
// await. That absolute write discarded every scroll the user made during the
// load — they scrolled down, got yanked back to the frozen position, and the
// auto-continue (maybeLoadOlder from afterUpdate) chained a second page and a
// second yank. The fix re-bases `anchorFromBottom` on every scroll event while
// `anchoring` is armed, so the restore preserves the user's LIVE position
// shifted by exactly the prepended height.
//
// Fixture: 400 messages; the engine serves newest-N with a 350ms delay so the
// load window is wide enough to scroll inside deterministically. RECENT_PAGE
// (80) loads first → tab.partial → scrolling near the top arms auto-backfill.
//
// The yank is a CONTENT teleport, not a scrollTop delta: the restore's absolute
// write lands at a similar scrollTop either way (it shifts by the prepended
// height), so the check pins the message under the viewport top before vs
// after the restore — same row = preserved, different row = teleported.
//
// Checks:
//   B0  boot: 80 rows (RECENT_PAGE window), partial transcript
//   B1  scroll down ~1400px during the in-flight load; after the restore the
//       SAME message stays under the viewport top (before the fix the frozen
//       anchor teleported the reader to a different row)
//   B2  scrollTop never jumps > 200px UP in a single frame during the window
//   B3  the older page actually landed (row count grew) — the test isn't
//       passing by skipping the backfill entirely
//
// Run:  node e2e/embedded/backfill-scroll.test.mjs

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, launchBrowser, screenshot, sleep } from '../helpers/setup.mjs';

const PORT = 8174;
const BASE = `http://127.0.0.1:${PORT}`;
const SID = 'ses_backfill01';
const TOTAL = 400;
const MSG_DELAY_MS = 900; // >> the wheel loop (~200ms) so the mid sample is pre-restore

// ============================== fake engine =================================

const T0 = Date.now() - 600_000;
const ALL = [];
for (let i = 1; i <= TOTAL; i++) {
  const user = i % 2 === 1;
  ALL.push({
    info: {
      id: user ? `msg_u${(i + 1) / 2}` : `msg_a${i / 2}`,
      role: user ? 'user' : 'assistant',
      agent: user ? 'build' : undefined,
      modelID: user ? undefined : 'x-preview-f-free',
      time: { created: T0 + i * 1000 },
    },
    parts: [
      {
        id: `part_${i}`,
        type: 'text',
        text: `#${i} ` + 'lorem ipsum dolor sit amet. '.repeat(5),
      },
    ],
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
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
    if (p.startsWith('/oc/session/') && p.endsWith('/prompt_async') && req.method === 'POST') {
      await readBody(req);
      res.writeHead(204);
      res.end();
      return;
    }
    if (p === '/api/history/sessions')
      return json(res, [
        { id: SID, title: 'backfill-probe', created: T0, updated: Date.now(), message_count: TOTAL, cost: 0 },
      ]);
    if (p.endsWith('/errors')) {
      if (req.method === 'GET') return json(res, []);
      return json(res, { ok: true });
    }
    if (p.startsWith('/api/history/session/')) return json(res, []);
    if (p === '/oc/session/status') return json(res, {});
    if (p.startsWith('/oc/session/') && p.endsWith('/message')) {
      const url = new URL(req.url, 'http://x');
      const limit = Number(url.searchParams.get('limit') || TOTAL);
      await sleep(MSG_DELAY_MS); // window for the test to scroll during the load
      return json(res, ALL.slice(-limit));
    }
    if (p.startsWith('/oc/session/'))
      return json(res, { id: SID, title: 'backfill-probe', revert: null });
    if (p === '/oc/config/providers')
      return json(res, {
        providers: [{ id: 'opencode', models: { 'x-preview-f-free': { id: 'x-preview-f-free' } } }],
      });
    if (p === '/oc/path') return json(res, { directory: '/workspace' });
    if (p === '/oc/mcp') return json(res, {});
    if (p.startsWith('/oc/')) return json(res, []);

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
    } catch {
      /* headers already sent */
    }
  }
});

// ================================ checks ====================================

const results = [];
let pageErrors = [];
function check(c, name, pass, note = '') {
  results.push({ c, name, pass: !!pass, note });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${c} · ${name}${note ? ` — ${note}` : ''}`);
}

async function scrollTopOf(page) {
  return page.evaluate(() => document.querySelector('.tabpane[style*="flex"] .transcript')?.scrollTop ?? -1);
}
async function rowCount(page) {
  return page.evaluate(() => document.querySelectorAll('.tabpane[style*="flex"] .msg').length);
}
// id of the message whose row straddles the viewport top (the row the reader
// is actually looking at)
async function rowAtViewportTop(page) {
  return page.evaluate(() => {
    const sc = document.querySelector('.tabpane[style*="flex"] .transcript');
    const top = sc.getBoundingClientRect().top;
    let best = null;
    for (const m of sc.querySelectorAll('.msg')) {
      const r = m.getBoundingClientRect();
      if (r.bottom > top + 2) return m.id || best;
      best = m.id;
    }
    return best;
  });
}

// ================================ run =======================================

try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const pane = page.locator('.tabpane[style*="flex"]');

  try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.locator('.sidebar button.item', { hasText: 'backfill-probe' }).waitFor({ timeout: 15000 });
    await pane.locator('.msg').last().waitFor({ timeout: 20000 });
    await sleep(600);

    // ---- B0 boot: windowed load --------------------------------------------
    console.log('\nCASE B0 — transcript boots windowed (partial)');
    const rows0 = await rowCount(page);
    check('B0', 'initial rows = RECENT_PAGE window (80)', rows0 === 80, `rows=${rows0}`);

    // park at top so the next scroll event arms auto-backfill (scrollTop <= 900)
    await page.keyboard.press('Home');
    await sleep(300);

    // sample scrollTop at rAF across the whole load+restore window
    await page.evaluate(() => {
      window.__tops = [];
      window.__rec = true;
      const sc = document.querySelector('.tabpane[style*="flex"] .transcript');
      const step = () => {
        if (!window.__rec) return;
        window.__tops.push([Math.round(performance.now()), Math.round(sc.scrollTop)]);
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });

    // ---- B1/B2/B3 scroll DOWN while the older-page load is in flight --------
    console.log('\nCASE B — scroll down during in-flight older-history load');
    const box = await pane.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -1); // fires onScroll near top → arms maybeLoadOlder
    await sleep(30); // request now in flight (server holds 350ms)
    for (let i = 0; i < 12; i++) {
      await page.mouse.wheel(0, 120);
      await sleep(15);
    }
    const mid = await page.evaluate(() => {
      const sc = document.querySelector('.tabpane[style*="flex"] .transcript');
      const top = sc.getBoundingClientRect().top;
      let row = null;
      for (const m of sc.querySelectorAll('.msg')) {
        if (m.getBoundingClientRect().bottom > top + 2) { row = m.id; break; }
      }
      return { top: Math.round(sc.scrollTop), row };
    });
    await sleep(900); // let the restore land (server holds 900ms + settle)
    const afterTop = await scrollTopOf(page);
    const afterRow = await rowAtViewportTop(page);
    const rowsAfter = await rowCount(page);

    // B1: the restore must keep the SAME row under the reader's eyes. Before
    // the fix it wrote an absolute scrollTop from a frozen anchor, teleporting
    // the reader to whatever row that stale offset mapped to after the prepend.
    check(
      'B1',
      'same row under the viewport top after the restore',
      mid.row != null && mid.row === afterRow,
      `row ${mid.row} → ${afterRow} (scrollTop ${mid.top} → ${afterTop})`,
    );

    // B2: no single-frame upward jump (the restore is one rAF write)
    const tops = await page.evaluate(() => {
      window.__rec = false;
      return window.__tops;
    });
    let worstUp = 0;
    for (let i = 1; i < tops.length; i++) {
      const d = tops[i][1] - tops[i - 1][1];
      if (-d > worstUp) worstUp = -d;
    }
    check('B2', 'no single-frame upward jump > 200px', worstUp <= 200, `worst=${Math.round(worstUp)}px`);

    // B3: the backfill actually landed (test isn't green by skipping it)
    check('B3', 'older page landed (row count grew)', rowsAfter > rows0, `${rows0} → ${rowsAfter}`);
    await screenshot(page, 'backfill-scroll');

    // ---- page health --------------------------------------------------------
    check('H', 'no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  } finally {
    await browser.close().catch(() => {});
  }
} finally {
  await new Promise((r) => server.close(r));
}

// =============================== summary ====================================

let fails = 0;
console.log('\n================ SUMMARY ================');
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
