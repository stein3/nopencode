// verify-scrollstick.mjs — headless regression for issue #7 (stein3/nopencode):
// "break scroll-down stickiness on any scroll-up" — one or two wheel notches
// up had the pin kick back in (old onScroll re-armed `stuck` whenever the
// position was inside a 120px bottom slop; a ~100px notch never escaped it,
// and the next ResizeObserver tick snapped the reader back mid-gesture).
//
// Fully self-contained: serves webui/dist + stub /oc endpoints + scripted SSE
// delta bursts via /__ctl (same conventions as verify-tasknotice.mjs). Delta
// bursts keep the feed growing so RO/follow pressure is continuous — exactly
// the condition where the old bug reproduced deterministically.
//
// Checks:
//   S1  boot: transcript opens pinned to the bottom
//   S2  THE FIX: ONE wheel notch up (-100px) during active streaming breaks
//       the pin and STAYS broken (distance-from-bottom never re-enters the
//       bottom corner while sampled every 100ms)
//   S3  a second notch keeps working: reader parks further up, unyanked
//   S4  streaming growth while unpinned does not drag the view downward
//   S5  scrolling back DOWN to the bottom re-arms the pin (proven by the view
//       staying glued while the burst keeps growing the feed)
//   K1  Home key unpins (view stays at top under continued growth)
//   K2  End key re-pins (view glued again)
//
// Run:  node e2e/embedded/scrollstick.test.mjs

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, launchBrowser, screenshot } from '../helpers/setup.mjs';

const PORT = 8139;
const BASE = `http://127.0.0.1:${PORT}`;
const SID = 'ses_scroll01';
const LIVE_MID = 'msg_a30';
const LIVE_PID = 'part_a30';

// ============================== fake engine =================================

const T0 = Date.now() - 120_000;
// 60 alternating user/assistant messages, ~550 chars each → a multi-thousand-px
// transcript. Last message is the assistant live part deltas stream into.
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
    // ---- test introspection + control --------------------------------------
    if (p === '/__state') return json(res, { burstRemaining: burst.remaining, deltasSent: burst.sent });
    if (p === '/__ctl') {
      const ctl = JSON.parse((await readBody(req)) || '{}');
      if (ctl.burst) startBurst(ctl.burst.n ?? 200, ctl.burst.size ?? 120, ctl.burst.iv ?? 45);
      if (ctl.stop) stopBurst();
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
          title: 'scroll-stick-probe',
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
      return json(res, { id: SID, title: 'scroll-stick-probe', revert: null });
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// distance-from-bottom of the ACTIVE pane's transcript scroller
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

// sample distance every `iv` ms for `ms`; returns all samples
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

let failures = 0;
try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const pane = page.locator('.tabpane[style*="flex"]');

  try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.locator('.sidebar button.item', { hasText: 'scroll-stick-probe' }).waitFor({ timeout: 15000 });
    await pane.locator('.msg').last().waitFor({ timeout: 15000 });
    await sleep(400); // settle mount-time follow()

    // ---- S1 boot pin --------------------------------------------------------
    console.log('\nCASE S1 — transcript boots pinned to the bottom');
    const d1 = await distFromBottom(page);
    check('S1', 'opened at bottom (distance < 24)', d1 >= 0 && d1 < 24, `distance=${d1}`);

    // ---- S2 one wheel notch up during streaming breaks the pin, FOR GOOD ----
    console.log('\nCASE S2 — single wheel notch up stays unstuck under RO pressure (issue #7)');
    await ctl({ burst: { n: 400, size: 120, iv: 45 } }); // ~18s of continuous growth
    await sleep(250); // let deltas flow so RO/follow pressure is live
    const box = await pane.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -100); // ONE realistic notch
    await sleep(150); // let the trailing scroll event land (old code re-sticks right here)
    const s2samples = await sampleDist(page, 900);
    const d2min = Math.min(...s2samples);
    const d2last = s2samples[s2samples.length - 1];
    check('S2', 'never snapped back (min sampled distance > 60)', d2min > 60, `min=${d2min}`);
    check('S2', 'still parked up after 1s of growth', d2last > 60, `final=${d2last}`);
    await screenshot(page, 'scrollstick-unpinned');

    // ---- S3 second notch ----------------------------------------------------
    console.log('\nCASE S3 — second notch parks the reader further up, unyanked');
    await page.mouse.wheel(0, -100);
    await sleep(150);
    const s3samples = await sampleDist(page, 700);
    const d3min = Math.min(...s3samples);
    const st3 = await scrollTopOf(page);
    check('S3', 'still unpinned (min distance > 160)', d3min > 160, `min=${d3min}, scrollTop=${st3}`);

    // ---- S4 growth does not drag an unpinned reader -------------------------
    console.log('\nCASE S4 — streaming growth leaves the parked reader alone');
    const beforeTop = await scrollTopOf(page);
    await sampleDist(page, 800);
    const afterTop = await scrollTopOf(page);
    check('S4', 'scrollTop did not move toward the bottom', afterTop <= beforeTop + 30, `${beforeTop} → ${afterTop}`);

    // ---- S5 return-to-bottom re-arms the pin --------------------------------
    console.log('\nCASE S5 — scrolling back down re-arms stick-to-bottom');
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, 2200);
      await sleep(140);
    }
    await sleep(250);
    const d5 = await distFromBottom(page);
    check('S5', 'back at the bottom corner (distance < 24)', d5 < 24, `distance=${d5}`);
    // prove the PIN (not just position): keep growing, view must stay glued
    const s5samples = await sampleDist(page, 900);
    const d5max = Math.max(...s5samples.filter((n) => Number.isFinite(n)));
    check('S5', 'view glued while feed grows (max distance < 24)', d5max < 24, `max=${d5max}`);
    await screenshot(page, 'scrollstick-resumed');

    // ---- K1/K2 Home/End -----------------------------------------------------
    console.log('\nCASE K — Home unpins, End re-pins');
    await ctl({ stop: true });
    await sleep(200);
    await page.keyboard.press('Home');
    await sleep(200);
    await ctl({ burst: { n: 120, size: 120, iv: 45 } });
    await sleep(700);
    const k1top = await scrollTopOf(page);
    check('K1', 'Home parks at top and stays under growth', k1top < 60, `scrollTop=${k1top}`);
    await page.keyboard.press('End');
    await sleep(300);
    const k2 = await distFromBottom(page);
    check('K2', 'End re-pins to the bottom corner', k2 < 24, `distance=${k2}`);
    await ctl({ stop: true });

    // ---- page health --------------------------------------------------------
    check('H', 'no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  } finally {
    await browser.close().catch(() => {});
  }
} finally {
  stopBurst();
  server.close();
}

failures = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failures}/${results.length} checks passed`);
process.exit(failures ? 1 : 0);
