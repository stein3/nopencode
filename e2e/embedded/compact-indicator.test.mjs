// compact-indicator.test.mjs — inline "Compacting session…" indicator in the
// Transcript, driven by the engine's session.next.compaction.* SSE events.
// Runs against an EMBEDDED fake engine (same pattern as qbanner.mjs).
//
// Cases:
//   A. session.next.compaction.started → .compacting row appears in transcript
//   B. session.next.compaction.ended  → indicator clears
//   C. started again, then session.idle (missed ended) → indicator clears
//
// Run: node e2e/embedded/compact-indicator.test.mjs

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, launchBrowser, screenshot, sleep } from '../helpers/setup.mjs';

const PORT = 8176;
const BASE = `http://127.0.0.1:${PORT}`;
const SID = 'ses_compact';

// ============================== fake engine =================================

const state = { counts: {} };
const sseClients = new Set();

function sseEmit(type, properties = {}) {
  const frame = `data: ${JSON.stringify({ type, properties })}\n\n`;
  for (const res of sseClients) {
    try { res.write(frame); } catch { /* dropped */ }
  }
}

const MESSAGES = [
  {
    info: { id: 'msg_c1', role: 'user', time: { created: Date.now() - 120_000 } },
    parts: [{ id: 'part_c1', type: 'text', text: 'seed user message' }],
  },
  {
    info: { id: 'msg_c2', role: 'assistant', agent: 'build', modelID: 'x-preview-f-free', providerID: 'opencode', time: { created: Date.now() - 110_000 } },
    parts: [{ id: 'part_c2', type: 'text', text: 'seed assistant reply' }],
  },
];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript',
  '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.map': 'application/json', '.txt': 'text/plain', '.wasm': 'application/wasm',
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
  state.counts[p] = (state.counts[p] ?? 0) + 1;

  try {
    if (p === '/__state') return json(res, { counts: state.counts });
    if (p === '/__ctl') {
      const ctl = JSON.parse((await readBody(req)) || '{}');
      if (ctl.emit) sseEmit(ctl.emit.type, ctl.emit.properties ?? {});
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

    if (p === '/api/history/sessions') {
      return json(res, [{
        id: SID, title: 'Compaction indicator smoke', created: Date.now() - 300_000,
        updated: Date.now() - 10_000, message_count: MESSAGES.length, cost: 0,
      }]);
    }
    if (p.endsWith('/errors')) {
      if (req.method === 'GET') return json(res, []);
      return json(res, { ok: true });
    }
    if (p.startsWith('/api/history/session/')) return json(res, []);

    if (p === '/oc/session/status') return json(res, {});
    if (p.startsWith('/oc/session/') && p.endsWith('/message')) return json(res, MESSAGES);
    if (p.startsWith('/oc/session/')) return json(res, { id: SID, title: 'Compaction indicator smoke', revert: null });
    if (p === '/oc/session' && req.method === 'POST')
      return json(res, { id: SID, title: 'Compaction indicator smoke', revert: null });
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
    const ct = MIME[path.extname(full)] ?? 'application/octet-stream';
    const b = fs.readFileSync(full);
    res.writeHead(200, { 'Content-Type': ct, 'Content-Length': b.length, 'Cache-Control': 'no-store' });
    res.end(b);
  } catch (e) {
    try { json(res, { error: String(e) }, 500); } catch { /* SSE */ }
  }
});

// ================================ helpers ====================================

const ctl = (payload) =>
  fetch(`${BASE}/__ctl`, { method: 'POST', body: JSON.stringify(payload) }).then((r) => r.json());

async function pollGone(page, sel, tries = 40) {
  for (let i = 0; i < tries; i++) {
    if ((await page.locator(sel).count()) === 0) return true;
    await sleep(300);
  }
  return false;
}

const results = [];
let pageErrors = [];

function check(c, name, pass, note = '') {
  results.push({ c, name, pass: !!pass, note });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${c} · ${name}${note ? ` — ${note}` : ''}`);
}

// ================================ run ========================================

try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const pane = page.locator('.tabpane[style*="flex"]');
  const indicator = pane.locator('.compacting');

  try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    // wait for the app to auto-open the seeded session
    await pane.locator('.msg').first().waitFor({ timeout: 15000 });
    check('A', 'no indicator before compaction starts', (await indicator.count()) === 0);

    // ---- A. started → indicator appears ------------------------------------
    console.log('\nCASE A — session.next.compaction.started shows indicator');
    await ctl({ emit: { type: 'session.next.compaction.started', properties: { sessionID: SID, messageID: 'msg_comp', reason: 'manual', timestamp: Date.now() } } });
    await indicator.waitFor({ timeout: 5000 });
    const txt = (await indicator.textContent()) ?? '';
    check('A', 'indicator shows "Compacting session"', /Compacting session/.test(txt), `text: ${txt.trim()}`);
    await screenshot(page, 'compact-indicator');

    // ---- B. ended → indicator clears ---------------------------------------
    console.log('\nCASE B — session.next.compaction.ended clears indicator');
    await ctl({ emit: { type: 'session.next.compaction.ended', properties: { sessionID: SID, messageID: 'msg_comp', reason: 'manual', text: 'summary', recent: 'recent', timestamp: Date.now() } } });
    check('B', 'indicator disappears after ended', await pollGone(page, '.tabpane[style*="flex"] .compacting'));

    // ---- C. started again, session.idle clears (missed ended) --------------
    console.log('\nCASE C — session.idle backstop clears a stuck indicator');
    await ctl({ emit: { type: 'session.next.compaction.started', properties: { sessionID: SID, messageID: 'msg_comp2', reason: 'auto', timestamp: Date.now() } } });
    await indicator.waitFor({ timeout: 5000 });
    await ctl({ emit: { type: 'session.idle', properties: { sessionID: SID } } });
    check('C', 'indicator disappears after session.idle', await pollGone(page, '.tabpane[style*="flex"] .compacting'));

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
