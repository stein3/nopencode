// Verify: grep tool cards now render their output box with a "(n matches)"
// footer at the bottom, count taken from the engine's "Found N matches" header.
//
// Runs against an EMBEDDED fake engine (same pattern as question-picker.test.mjs):
// in-process HTTP server serving webui/dist + stubbed /oc endpoints. No live
// engine or chatserver needed.
//
// Run: node e2e/embedded/grep-count.test.mjs

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, launchBrowser, SHOTS_DIR } from '../helpers/setup.mjs';

const PORT = 8140;
const BASE = `http://127.0.0.1:${PORT}`;
const SID = 'ses_grepcount01';
const MSG_ID = 'msg_grepcount1';

// ============================== fake engine =================================

const sseClients = new Set();

function sseEmit(type, properties = {}) {
  const frame = `data: ${JSON.stringify({ type, properties })}\n\n`;
  for (const res of sseClients) {
    try { res.write(frame); } catch { /* dropped */ }
  }
}

// Assistant message containing a grep tool card with a "Found N matches" header.
const MESSAGES = [
  {
    info: {
      id: MSG_ID,
      role: 'assistant',
      agent: 'build',
      modelID: 'x-preview-f-free',
      providerID: 'opencode',
      time: { created: Date.now() - 60_000 },
    },
    parts: [
      {
        id: 'part_grep1',
        type: 'tool',
        tool: 'grep',
        state: {
          status: 'completed',
          input: { pattern: 'foo', path: '/workspace' },
          output:
            'Found 3 matches\n  Line 12: foo\n  Line 45: bar\n  Line 78: baz',
        },
      },
    ],
  },
];

const SESSIONS = [
  {
    id: SID,
    title: 'Grep match count in opencode output',
    created: Date.now() - 120_000,
    updated: Date.now() - 30_000,
    message_count: 1,
    cost: 0,
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

    // ---- history (chatserver stubs) ------------------------------------------
    if (p === '/api/history/sessions') return json(res, SESSIONS);
    if (p.endsWith('/errors')) {
      if (req.method === 'GET') return json(res, []);
      return json(res, { ok: true });
    }
    if (p.startsWith('/api/history/session/')) return json(res, []);

    // ---- engine stubs --------------------------------------------------------
    if (p === '/oc/session/status') return json(res, {});
    if (p.startsWith('/oc/session/') && p.endsWith('/message'))
      return json(res, MESSAGES);
    if (p.startsWith('/oc/session/'))
      return json(res, { id: SID, title: 'Grep match count in opencode output', revert: null });
    if (p === '/oc/session' && req.method === 'POST')
      return json(res, { id: SID, title: 'Grep match count in opencode output', revert: null });
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

  const TITLE = 'Grep match count in opencode output';

  const browser = await launchBrowser();
  // Tall viewport: the expanded outbox can exceed 1600px. A normal viewport
  // forces beyond-viewport element capture, where content-visibility:auto skips
  // painting the offscreen part of the .msg row (blank lower half, missing
  // footer) and the sticky composer composites over the element rect. On-screen
  // capture avoids both artifacts.
  const page = await browser.newPage({ viewport: { width: 1280, height: 1900 } });
  page.on('pageerror', (e) => pageErrors.push(e.message));

  // Freeze ALL live churn during capture: SSE events AND busy-flip refetches.
  // Initial loads must pass through, so these routes only start aborting once
  // the fixture tab has rendered.
  let frozen = false;
  const FREEZE_RE = /\/oc\/event|\/oc\/session\/status|\/session\/[^/]+\/message/;
  await page.route(FREEZE_RE, (route) =>
    frozen ? route.abort() : route.fallback(),
  );

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForSelector('.sidebar .item', { timeout: 15000 });

    // Open the fixture session via its sidebar row (title attr holds the session title)
    const row = page.locator(`.sidebar .item[title="${TITLE}"]`);
    if (!(await row.count())) throw new Error('fixture session not found in sidebar');
    await row.click();

    // Inactive tab panes stay mounted under display:none — scope to the VISIBLE one
    const PANE = '.tabpane[style*="flex"]';
    try {
      await page.waitForSelector(`${PANE} .toolcard`, { timeout: 8000 });
    } catch {
      // Pane didn't activate — click the session's tab in the tab bar
      const tb = page.locator(`.tabbar .tab[title="${TITLE}"]`);
      if (!(await tb.count())) throw new Error('fixture tab not found in tab bar');
      await tb.click();
    }
    await page.waitForSelector(`${PANE} .toolcard`, { timeout: 15000 });

    // Find a grep tool card
    const cards = page.locator(`${PANE} .toolcard`);
    // Freeze live churn only once the FIXTURE session's own content is rendered
    await page.waitForSelector(`${PANE} .toolcard summary .tname:text-matches("grep", "i")`, { timeout: 15000 });
    frozen = true;

    const n = await cards.count();
    let grepIdx = -1;
    for (let i = 0; i < n; i++) {
      const t = (await cards.nth(i).locator('summary .tname').textContent()) ?? '';
      if (/grep/i.test(t)) { grepIdx = i; break; }
    }
    if (grepIdx < 0) throw new Error('no grep tool card found in session');

    // Find one that has an output box (errored greps legitimately have none)
    let outbox = null;
    for (let i = grepIdx; i < n; i++) {
      const t = (await cards.nth(i).locator('summary .tname').textContent()) ?? '';
      if (!/grep/i.test(t)) continue;
      const ob = cards.nth(i).locator('details.outbox').first();
      if (await ob.count()) { outbox = ob; break; }
    }
    if (!outbox) throw new Error('no completed grep tool card with output box found');
    await outbox.scrollIntoViewIfNeeded();
    await outbox.locator('summary').click(); // expand
    await page.waitForTimeout(200);

    const outText = (await outbox.locator('pre.out').textContent()) ?? '';
    const footer = outbox.locator('.matchcount');
    check('A', 'outbox renders', true);
    check('A', 'matchcount footer present', (await footer.count()) > 0);

    const footText = ((await footer.textContent()) ?? '').trim();
    const header = outText.match(/^Found (\d+) matches/);
    check('A', 'output has Found N matches header', !!header, header ? header[1] : '');
    if (header) {
      const expect = `(${header[1]} ${Number(header[1]) === 1 ? 'match' : 'matches'})`;
      check('A', 'footer text matches header count', footText === expect, `footer="${footText}" expect="${expect}"`);
    }

    // Clear the transcript's stick-to-bottom pin with REAL wheel-up input
    const paneBox = await page.locator(PANE).boundingBox();
    await page.mouse.move(paneBox.x + paneBox.width / 2, paneBox.y + paneBox.height / 2);
    await page.mouse.wheel(0, -800);
    await page.waitForTimeout(100);

    // Align the outbox top for screenshot
    await outbox.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    if ((await outbox.getAttribute('open')) === null) await outbox.locator('summary').click();
    const bbox = await outbox.boundingBox();
    if (!bbox || bbox.height < 40)
      throw new Error(`outbox bbox too small: ${JSON.stringify(bbox)}`);

    // Whole box must sit above the sticky composer
    const compBox = await page.locator(`${PANE} #composer-input`).boundingBox();
    if (compBox && bbox.y + bbox.height > compBox.y - 8)
      throw new Error(`outbox bottom (${bbox.y + bbox.height}) reaches composer top (${compBox.y})`);

    await page.waitForTimeout(100);
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    await outbox.screenshot({ path: `${SHOTS_DIR}/grep-matchcount-${Date.now()}.png` });
    await page.screenshot({ path: `${SHOTS_DIR}/grep-matchcount-full.png` });
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
