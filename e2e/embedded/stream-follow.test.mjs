// stream-follow.test.mjs — headless regression for: "transcript no longer auto
// scrolls down as new messages stream in" (stein3/nopencode).
//
// Root cause: the scrollbar-drag pin fix (onScroll unsticks on ANY upward move
// >2px) also catches browser SHRINK CLAMPS. When the live message's rendered
// height drops mid-stream — a message.part.updated snapshot replacing
// delta-ahead text, a fence-cap flip, a {@html}-swapped image node — the
// browser clamps scrollTop down to the new bottom: an upward scroll event the
// user never made. stuck=false, follow() stops writing, and nothing re-arms
// the pin (re-arm needs a DOWNWARD scroll the user never sends). Auto-follow
// is dead for the rest of the turn.
//
// A clamp always lands the viewport AT the new bottom (distance 0); a genuine
// user scroll-up lands away from the corner. The fix guards the unstick with
// !nearBottom(scroller).
//
// Self-contained: serves webui/dist + stub /oc endpoints + scripted SSE via
// /__ctl (same conventions as scrollstick.test.mjs).
//
// Checks:
//   F1  boot: transcript opens pinned to the bottom
//   F2  streaming deltas while pinned: view stays glued (control)
//   F3  THE FIX: a short message.part.updated snapshot shrinks the live
//       message mid-stream; the clamp must NOT kill the pin — the view stays
//       glued as fresh deltas keep arriving
//   F4  a genuine wheel scroll-up still breaks the pin (nearBottom guard must
//       not swallow real unstick)
//   F5  scrolling back DOWN re-arms the pin (glued again under growth)
//
// Run:  node e2e/embedded/stream-follow.test.mjs

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, launchBrowser, screenshot, sleep } from '../helpers/setup.mjs';

const PORT = 8175;
const BASE = `http://127.0.0.1:${PORT}`;
const SID = 'ses_follow01';
const LIVE_MID = 'msg_a30';
const LIVE_PID = 'part_a30';

// ============================== fake engine =================================

const T0 = Date.now() - 120_000;
const MESSAGES = [];
for (let i = 1; i <= 60; i++) {
  const user = i % 2 === 1;
  MESSAGES.push({
    info: {
      id: user ? `msg_u${(i + 1) / 2}` : `msg_a${i / 2}`,
      role: user ? 'user' : 'assistant',
      agent: user ? 'build' : undefined,
      modelID: user ? undefined : 'x-preview-f-free',
      time: { created: T0 + i * 1800 },
    },
    parts: [
      {
        id: user ? `part_u${(i + 1) / 2}` : `part_a${i / 2}`,
        type: 'text',
        text: `${user ? 'request' : 'reply'} #${i}: ` + 'lorem ipsum dolor sit amet consectetur '.repeat(20),
      },
    ],
  });
}

const sseClients = new Set();
function sseEmit(type, properties = {}) {
  const frame = `data: ${JSON.stringify({ type, properties })}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      /* dropped client */
    }
  }
}

const burst = { timer: undefined, remaining: 0, sent: 0 };
function startBurst(n, size, iv) {
  stopBurst();
  burst.remaining = n;
  burst.timer = setInterval(() => {
    if (burst.remaining-- <= 0) return stopBurst();
    burst.sent++;
    sseEmit('message.part.delta', {
      sessionID: SID,
      messageID: LIVE_MID,
      partID: LIVE_PID,
      field: 'text',
      delta: ' stream-delta token blah '.repeat(Math.max(1, Math.round(size / 26))),
    });
  }, iv);
}
function stopBurst() {
  if (burst.timer) clearInterval(burst.timer);
  burst.timer = undefined;
}

// Engine-side snapshot that REPLACES the live part's text — the real race
// this models: a delta landed locally after the engine generated its snapshot,
// so the snapshot text is shorter than the delta-ahead accumulation. upsertPart
// overwrites text → the live message shrinks → the browser clamps scrollTop.
function shrinkSnapshot() {
  sseEmit('message.part.updated', {
    part: {
      id: LIVE_PID,
      messageID: LIVE_MID,
      sessionID: SID,
      type: 'text',
      text: 'snapshot behind local deltas — shrunken '.repeat(3),
    },
  });
}

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
    if (p === '/__state') return json(res, { burstRemaining: burst.remaining, deltasSent: burst.sent });
    if (p === '/__ctl') {
      const ctl = JSON.parse((await readBody(req)) || '{}');
      if (ctl.burst) startBurst(ctl.burst.n ?? 200, ctl.burst.size ?? 120, ctl.burst.iv ?? 45);
      if (ctl.stop) stopBurst();
      if (ctl.shrink) shrinkSnapshot();
      return json(res, { ok: true });
    }

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

    if (p.startsWith('/oc/session/') && p.endsWith('/prompt_async') && req.method === 'POST') {
      await readBody(req);
      res.writeHead(204);
      res.end();
      return;
    }
    if (p === '/api/history/sessions')
      return json(res, [
        {
          id: SID,
          title: 'stream-follow-probe',
          created: T0,
          updated: Date.now(),
          message_count: MESSAGES.length,
          cost: 0,
        },
      ]);
    if (p.endsWith('/errors')) {
      if (req.method === 'GET') return json(res, []);
      return json(res, { ok: true });
    }
    if (p.startsWith('/api/history/session/')) return json(res, []);
    if (p === '/oc/session/status') return json(res, {});
    if (p.startsWith('/oc/session/') && p.endsWith('/message')) return json(res, MESSAGES);
    if (p.startsWith('/oc/session/'))
      return json(res, { id: SID, title: 'stream-follow-probe', revert: null });
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
      /* headers already sent (SSE) */
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

async function distFromBottom(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.tabpane[style*="flex"] .transcript');
    if (!el) return -1;
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  });
}
async function scrollTopOf(page) {
  return page.evaluate(() => document.querySelector('.tabpane[style*="flex"] .transcript')?.scrollTop ?? -1);
}
async function liveTextLen(page) {
  return page.evaluate(() => {
    const rows = document.querySelectorAll('.tabpane[style*="flex"] .msg');
    const last = rows[rows.length - 1];
    return last?.textContent?.length ?? -1;
  });
}

async function sampleDist(page, ms, iv = 100) {
  const samples = [];
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    samples.push(await distFromBottom(page));
    await sleep(iv);
  }
  return samples;
}

const ctl = (payload) =>
  fetch(`${BASE}/__ctl`, { method: 'POST', body: JSON.stringify(payload) }).then((r) => r.json());

// ================================ run =======================================

try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const pane = page.locator('.tabpane[style*="flex"]');

  try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.locator('.sidebar button.item', { hasText: 'stream-follow-probe' }).waitFor({ timeout: 15000 });
    await pane.locator('.msg').last().waitFor({ timeout: 15000 });
    await sleep(400); // settle mount-time follow()

    // ---- F1 boot pin --------------------------------------------------------
    console.log('\nCASE F1 — transcript boots pinned to the bottom');
    const d1 = await distFromBottom(page);
    check('F1', 'opened at bottom (distance < 24)', d1 >= 0 && d1 < 24, `distance=${d1}`);

    // ---- F2 control: streaming growth while pinned stays glued --------------
    console.log('\nCASE F2 — streaming deltas while pinned: view stays glued');
    await ctl({ burst: { n: 400, size: 120, iv: 45 } });
    await sleep(1200); // let deltas accumulate → a tall live message
    const f2 = await sampleDist(page, 800);
    const f2max = Math.max(...f2.filter((n) => Number.isFinite(n)));
    check('F2', 'view glued while feed grows (max distance < 80)', f2max < 80, `max=${f2max}`);

    // ---- F3 THE FIX: shrink clamp mid-stream must not kill the pin ----------
    console.log('\nCASE F3 — part.updated snapshot shrink must not unstick auto-follow');
    const lenBefore = await liveTextLen(page);
    await ctl({ shrink: true }); // snapshot replaces delta-ahead text → live msg shrinks
    await sleep(300); // clamp scroll event lands in here (old code: stuck=false)
    const lenAfter = await liveTextLen(page);
    check('F3', 'shrink actually shortened the live message', lenAfter < lenBefore, `${lenBefore} → ${lenAfter} chars`);
    // burst keeps running: deltas append to the shrunken text. If the clamp
    // killed the pin, distance grows with every delta and never recovers.
    const f3 = await sampleDist(page, 1500);
    const f3max = Math.max(...f3.filter((n) => Number.isFinite(n)));
    const f3last = f3[f3.length - 1];
    check('F3', 'auto-follow survived the clamp (max distance < 80)', f3max < 80, `max=${f3max}`);
    check('F3', 'still glued 1.5s later', f3last < 80, `final=${f3last}`);
    await screenshot(page, 'stream-follow-after-shrink');

    // ---- F4 genuine wheel scroll-up still breaks the pin --------------------
    console.log('\nCASE F4 — a real wheel notch up still unsticks');
    const box = await pane.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -100);
    await sleep(150);
    const f4 = await sampleDist(page, 900);
    const f4min = Math.min(...f4);
    check('F4', 'unpinned and never yanked back (min distance > 60)', f4min > 60, `min=${f4min}`);

    // ---- F5 return-to-bottom re-arms ----------------------------------------
    console.log('\nCASE F5 — scrolling back down re-arms the pin');
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, 2200);
      await sleep(140);
    }
    await sleep(250);
    const f5 = await sampleDist(page, 900);
    const f5max = Math.max(...f5.filter((n) => Number.isFinite(n)));
    check('F5', 'view glued again while feed grows (max distance < 80)', f5max < 80, `max=${f5max}`);
    await ctl({ stop: true });

    // ---- page health --------------------------------------------------------
    check('H', 'no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  } finally {
    await browser.close().catch(() => {});
  }
} finally {
  stopBurst();
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
