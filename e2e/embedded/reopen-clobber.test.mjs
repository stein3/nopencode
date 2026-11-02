// reopen-clobber.test.mjs — regression: re-opening an ALREADY-OPEN session
// (a sidebar row click) must not blank its loaded transcript.
//
// Root cause (fixed in stores.ts): tabs.open() merged a re-open with a bare
// `{ ...tab, ...t }`, so every `openTab({ messages: [] })` — the "nothing known
// yet" placeholder openHistory/openLive pass before their refetch — clobbered
// the loaded messages. When the refill then fails (engine blip: oc.messages
// throws, openLive falls into the history view whose snapshot can be empty),
// the tab STAYED empty: the reader clicks the sidebar row of the open session
// and its transcript vanishes ("No message data for this session."). This is
// the failure that surfaced as grep-count's flaky "no grep tool card found".
//
// The test boots the app with one session (the boot auto-open loads it), flips
// the fake engine to 503 on /session/*/message, then clicks the sidebar row —
// the re-open's refill fails exactly like an engine blip — and asserts the
// transcript survives.
//
// Checks:
//   R0  the re-open actually re-fetched (the test isn't green by skipping it)
//   R1  the grep tool card is still rendered after the failed re-open
//   R2  message row count unchanged
//   R3  no empty-state placeholder appeared
//   H   no page errors
//
// Run:  node e2e/embedded/reopen-clobber.test.mjs

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, launchBrowser, screenshot, createChecker, sleep } from '../helpers/setup.mjs';

const PORT = 8186;
const BASE = `http://127.0.0.1:${PORT}`;
const SID = 'ses_reopen01';
const TITLE = 'reopen-probe';

// ============================== fake engine =================================

const sseClients = new Set();
let failMessages = false;
let messageCalls = 0;

const MESSAGES = [
  {
    info: {
      id: 'msg_u1',
      role: 'user',
      agent: 'build',
      time: { created: Date.now() - 120_000 },
    },
    parts: [{ id: 'part_u1', type: 'text', text: 'find the matches' }],
  },
  {
    info: {
      id: 'msg_a1',
      role: 'assistant',
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
          output: 'Found 3 matches\n  Line 12: foo\n  Line 45: bar\n  Line 78: baz',
        },
      },
    ],
  },
];

const SESSIONS = [
  {
    id: SID,
    title: TITLE,
    created: Date.now() - 300_000,
    updated: Date.now() - 60_000,
    message_count: MESSAGES.length,
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
    if (p === '/__ctl' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if ('failMessages' in body) failMessages = !!body.failMessages;
      return json(res, { ok: true, failMessages, messageCalls });
    }
    if (p === '/__state') return json(res, { failMessages, messageCalls });

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
    if (p === '/api/history/sessions') return json(res, SESSIONS);
    if (p.endsWith('/errors')) {
      if (req.method === 'GET') return json(res, []);
      return json(res, { ok: true });
    }
    if (p.startsWith('/api/history/session/')) return json(res, []); // empty snapshot — the blip shape
    if (p === '/oc/session/status') return json(res, {});
    if (p.startsWith('/oc/session/') && p.endsWith('/message')) {
      messageCalls++;
      if (failMessages) return json(res, { error: 'engine blip' }, 503);
      return json(res, MESSAGES);
    }
    if (p.startsWith('/oc/session/')) return json(res, { id: SID, title: TITLE, revert: null });
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

// ================================ run =======================================

const { check, summary } = createChecker();
const pageErrors = [];

try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const pane = page.locator('.tabpane[style*="flex"]');

  try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const row = page.locator(`.sidebar .item[title="${TITLE}"]`);
    await row.waitFor({ timeout: 15000 });

    // Boot auto-open loads the session — wait for the fixture content to render
    await pane.locator('.toolcard summary .tname').first().waitFor({ timeout: 20000 });
    const rowsBefore = await pane.locator('.msg').count();

    // From now on the engine is "down" for message fetches — like a blip
    await fetch(`${BASE}/__ctl`, {
      method: 'POST',
      body: JSON.stringify({ failMessages: true }),
    });

    // Re-open the ALREADY-OPEN session: openHistory → openTab({messages: []})
    // → openLive refill fails (503) → history fallback returns []
    const callsBefore = messageCalls;
    await row.click();
    await sleep(1200); // let the whole re-open chain land

    const state = await (await fetch(`${BASE}/__state`)).json();
    check('R0 · the re-open re-fetched messages', state.messageCalls > callsBefore,
      `calls ${callsBefore} → ${state.messageCalls}`);

    const cards = await pane.locator('.toolcard summary .tname').count();
    check('R1 · grep tool card survives the failed re-open', cards > 0, `toolcards=${cards}`);

    const rowsAfter = await pane.locator('.msg').count();
    check('R2 · message row count unchanged', rowsAfter === rowsBefore,
      `rows ${rowsBefore} → ${rowsAfter}`);

    const paneText = ((await pane.innerText()) ?? '').toLowerCase();
    const emptyState = paneText.includes('no message data') || paneText.includes('type below to start');
    check('R3 · no empty-state placeholder', !emptyState, emptyState ? 'empty state shown' : '');

    await screenshot(page, 'reopen-clobber');
    check('H · no page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
  } finally {
    await browser.close().catch(() => {});
  }
} finally {
  await new Promise((r) => server.close(r));
}

const nfail = summary();
process.exitCode = nfail ? 1 : 0;
