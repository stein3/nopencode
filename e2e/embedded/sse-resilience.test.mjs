// sse-resilience.test.mjs — regression for the three webui streaming bugs
// root-caused 2026-09 (stream history loss + sessions going wholly dark):
//
//   A. Sidebar re-open of an already-open BUSY session must not wipe/truncate
//      the streamed-so-far text. Covers BOTH fix layers:
//        A1: openHistory (App.svelte) skips the messages:[] wipe + refetch
//            while the tab is busy (no GET /message at all).
//        A2: applyMessages (sse.ts) is add-only while busy — a mid-stream
//            refetch (here: the post-send openLive) appends the new user
//            message but keeps local delta-ahead text on existing messages
//            (the fake engine's persisted snapshot intentionally LAGS).
//   B. A fatal EventSource reconnect (any non-200 → per HTML spec the browser
//      "fails the connection" and NEVER retries) must be recreated by the
//      client (onerror→scheduleRecreate / 10s watchdog) instead of going
//      dark until a page reload. Asserted by: after one 503'd reconnect, the
//      client opens a NEW stream by itself and a subsequent SSE event is
//      applied (tab title updates).
//   C. A session.idle missed during an SSE blackout leaves busy=true stuck
//      (which blocks every scheduleRefetch forever). On the next re-open the
//      client's catchUp() reconciles busy from GET /session/status and
//      refetches the tab's messages.
//
// Fake engine: single root session, /oc/session/status says busy until ctl
// flips it, persisted GET /message text lags SSE deltas (mirrors the real
// engine's in-flight reasoning-part persistence lag), prompt_async appends a
// user message server-side, /oc/event can be dropped/503'd on demand.
//
// Run:  node e2e/embedded/sse-resilience.test.mjs

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, SHOTS_DIR, launchBrowser, screenshot, sleep, poll } from '../helpers/setup.mjs';

const PORT = Number(process.env.PORT) || 8169;
const BASE = `http://127.0.0.1:${PORT}`;
const SID = 'ses_resil01';

// ============================== fake engine =================================

const sseClients = new Set();
const state = {
  statusBusy: true, // openLive seeds tab.busy from this at boot
  sseMode: 'ok', // 'ok' → 200 event-stream, 'fail' → 503 html (spec-fatal)
  sseOk: 0, // successful 200 streams served
  sseFail: 0, // 503'd reconnect attempts
  messages: { [SID]: 0 }, // GET /session/{sid}/message call counts
};

function dropSse() {
  for (const res of sseClients) {
    try {
      res.destroy();
    } catch {
      /* gone */
    }
  }
  sseClients.clear();
}

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

const T0 = Date.now() - 60_000;
const PREFIX = 'Persistent prefix of the in-flight turn: ';
const D1 = ' streamed-one';
const D2 = ' streamed-two';
const D3 = ' streamed-three';
const STREAMED = PREFIX + D1 + D2; // what the LOCAL tab must keep across refetches

// Persisted (server) view: text part WITHOUT the SSE deltas — the lag the
// real engine exhibits for in-flight reasoning parts (see sse.ts
// scheduleRefetch comment). Deltas are intentionally NOT mirrored here.
const MESSAGES = {
  [SID]: [
    {
      info: { id: 'msg_u1', role: 'user', time: { created: T0 } },
      parts: [{ id: 'part_u1', type: 'text', text: 'Please analyze this code' }],
    },
    {
      info: {
        id: 'msg_a1',
        role: 'assistant',
        modelID: 'm',
        providerID: 'p',
        sessionID: SID,
        parentID: 'msg_u1',
        time: { created: T0 + 1000 },
      },
      parts: [{ id: 'part_a1', type: 'text', text: PREFIX }],
    },
  ],
};

const T_RUN = Date.now();
const log = (msg) => console.log(`  [srv +${((Date.now() - T_RUN) / 1000).toFixed(1)}s] ${msg}`);

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
    if (p === '/__state') return json(res, state);
    if (p === '/__ctl') {
      const ctl = JSON.parse((await readBody(req)) || '{}');
      if (ctl.statusBusy !== undefined) state.statusBusy = !!ctl.statusBusy;
      if (ctl.sseMode) state.sseMode = ctl.sseMode;
      if (ctl.dropSse) dropSse();
      if (ctl.emit) sseEmit(ctl.emit.type, ctl.emit.properties ?? {});
      log(`ctl ${JSON.stringify(ctl)}`);
      return json(res, { ok: true });
    }
    if (p === '/oc/event') {
      if (state.sseMode === 'fail') {
        // Spec-fatal: non-200 → the browser fails the connection for good.
        state.sseFail += 1;
        log('sse 503');
        res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html>bad gateway</html>');
        return;
      }
      state.sseOk += 1;
      log('sse 200 open');
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
    if (p === '/oc/session/status')
      return json(res, state.statusBusy ? { [SID]: { type: 'busy' } } : {});
    if (p.startsWith('/oc/session/') && p.endsWith('/prompt_async') && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const text = (body.parts ?? []).filter((x) => x.type === 'text').map((x) => x.text).join('\n');
      // engine-side materialization: the post-send openLive fetch must see it
      MESSAGES[SID].push({
        info: {
          id: 'msg_u' + Date.now().toString(36),
          role: 'user',
          time: { created: Date.now() },
        },
        parts: [{ id: 'part_u' + Date.now().toString(36), type: 'text', text }],
      });
      res.writeHead(204);
      res.end();
      return;
    }
    const mMsg = p.match(/^\/oc\/session\/([^/]+)\/message$/);
    if (mMsg) {
      state.messages[mMsg[1]] = (state.messages[mMsg[1]] ?? 0) + 1;
      log(`GET message ${mMsg[1]} (#${state.messages[mMsg[1]]})`);
      return json(res, MESSAGES[mMsg[1]] ?? []);
    }
    if (p === '/api/history/sessions')
      return json(res, [
        { id: SID, title: 'sse-resilience-probe', created: T0, updated: Date.now(), message_count: MESSAGES[SID].length, cost: 0 },
      ]);
    if (p.endsWith('/errors')) {
      if (req.method === 'GET') return json(res, []);
      return json(res, { ok: true });
    }
    if (p.startsWith('/api/history/session/')) return json(res, []);
    if (p.startsWith('/oc/session/')) return json(res, { id: SID, title: 'sse-resilience-probe', revert: null, cost: 0 });
    if (p === '/oc/config/providers')
      return json(res, { providers: [{ id: 'opencode', models: { 'm': { id: 'm' } } }] });
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
    console.log('  [server]', p, '→', e.message);
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
const ctl = (payload) =>
  fetch(`${BASE}/__ctl`, { method: 'POST', body: JSON.stringify(payload) }).then((r) => r.json());
const stateOf = () => fetch(`${BASE}/__state`).then((r) => r.json());
// Wait until the boot-time message fetchers (openLive, Footer busy-flip,
// InfoPanel key refresh) have gone quiet, so before/after diffs only see
// fetches caused by the action under test.
const stableCount = async () => {
  let last = -1;
  let same = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    const v = (await stateOf()).messages[SID];
    if (v === last && ++same >= 3) return v;
    if (v !== last) same = 0;
    last = v;
    await sleep(200);
  }
  return last;
};

async function assistantText(page) {
  return page
    .locator(`#m-msg_a1 .body`)
    .innerText()
    .catch(() => '');
}

// ================================ run =======================================

try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const pane = page.locator('.tabpane[style*="flex"]');
  const busyDot = page.locator(`.tabbar .tab[data-sid="${SID}"] .dot.busy`);

  try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.locator('.sidebar button.item', { hasText: 'sse-resilience-probe' }).waitFor({ timeout: 15000 });
    await pane.locator('.msg', { hasText: 'Please analyze this code' }).first().waitFor({ timeout: 15000 });
    // boot auto-open → openLive seeds busy from /session/status
    await poll(async () => (await busyDot.count()) > 0, 8000);
    check('A1', 'tab opens busy (status map seed)', (await busyDot.count()) > 0);

    // Local text runs AHEAD of the persisted snapshot (the real engine's
    // in-flight reasoning lag): emit deltas WITHOUT mirroring them server-side.
    for (const delta of [D1, D2]) {
      await ctl({
        emit: {
          type: 'message.part.delta',
          properties: { sessionID: SID, messageID: 'msg_a1', partID: 'part_a1', field: 'text', delta },
        },
      });
    }
    await sleep(300);
    let txt = await assistantText(page);
    check('A1', 'local text includes both deltas (SSE-ahead of server)', txt.includes(D1) && txt.includes(D2), txt.slice(-90));

    // ---- CASE A1: sidebar re-open of the open BUSY tab ------------------
    console.log('\nCASE A1 — sidebar re-open of open busy tab: no wipe, no refetch');
    const before = await stableCount();
    await page.locator('.sidebar button.item', { hasText: 'sse-resilience-probe' }).click();
    await sleep(800);
    const after = (await stateOf()).messages[SID];
    txt = await assistantText(page);
    check('A1', 'streamed text intact after sidebar re-open', txt.includes(D1) && txt.includes(D2), txt.slice(-90));
    check('A1', 'no GET /message refetch fired by the re-open', after === before, `${before} → ${after}`);
    // stream keeps appending from the LOCAL position (not the server's)
    await ctl({
      emit: {
        type: 'message.part.delta',
        properties: { sessionID: SID, messageID: 'msg_a1', partID: 'part_a1', field: 'text', delta: D3 },
      },
    });
    await sleep(250);
    txt = await assistantText(page);
    check('A1', 'stream continues on top of local text', txt.includes(D2) && txt.includes(D3), txt.slice(-90));

    // ---- CASE A2: mid-turn refetch (post-send openLive) is add-only -------
    console.log('\nCASE A2 — mid-turn refetch appends the user msg, keeps local text');
    const beforeA2 = (await stateOf()).messages[SID];
    await pane.locator('#composer-input').fill('follow-up after streaming');
    await pane.locator('#composer-input').press('Enter');
    // onSent → openLive at +150ms fetches the (lagging) snapshot; add-only
    // merge must append the new user message WITHOUT rewriting msg_a1.
    await poll(async () => (await stateOf()).messages[SID] > beforeA2, 6000).catch(() => 0);
    await poll(async () => (await page.locator('.msg', { hasText: 'follow-up after streaming' }).count()) > 0, 6000);
    const userVisible = (await page.locator('.msg', { hasText: 'follow-up after streaming' }).count()) > 0;
    txt = await assistantText(page);
    check('A2', 'new user message materialized from the mid-turn refetch', userVisible);
    check('A2', 'existing streamed text NOT truncated by the refetch', txt.includes(D1) && txt.includes(D2), txt.slice(-90));
    await screenshot(page, 'sse-resilience-busy');

    // ---- CASE B: spec-fatal SSE reconnect → client must recreate ----------
    console.log('\nCASE B — 503 reconnect (spec-fatal) → client recreates the stream');
    await ctl({ sseMode: 'fail', dropSse: true });
    // The browser's native retry hits the 503 → per spec it fails the
    // connection permanently. Wait until that attempt is recorded...
    await poll(async () => (await stateOf()).sseFail >= 1, 12000).catch(() => 0);
    const failSeen = (await stateOf()).sseFail;
    const okBefore = (await stateOf()).sseOk;
    check('B', 'native reconnect was served the fatal 503', failSeen >= 1, `sseFail=${failSeen}`);
    // ...then let the origin recover. Pre-fix: nothing ever asks again
    // (EventSource is CLOSED). Post-fix: scheduleRecreate/watchdog opens a
    // fresh stream within seconds.
    await ctl({ sseMode: 'ok' });
    await poll(async () => (await stateOf()).sseOk > okBefore, 15000).catch(() => 0);
    const okAfter = (await stateOf()).sseOk;
    check('B', 'client opened a NEW stream after the fatal error', okAfter > okBefore, `ok ${okBefore} → ${okAfter}`);
    // ...and events on it are actually applied (tab title patch)
    await ctl({
      emit: {
        type: 'session.updated',
        properties: { info: { id: SID, title: 'reconnected-title', revert: null } },
      },
    });
    await poll(async () => (await page.locator('.tabbar .label', { hasText: 'reconnected-title' }).count()) > 0, 6000);
    const gotTitle = (await page.locator('.tabbar .label', { hasText: 'reconnected-title' }).count()) > 0;
    check('B', 'SSE event on the new stream applied (tab title)', gotTitle);
    await screenshot(page, 'sse-resilience-reconnect');

    // ---- CASE C: missed session.idle → busy heals on reconnect ------------
    console.log('\nCASE C — missed session.idle: catchUp reconciles busy + refetches');
    // The turn "finished" while the stream was down: status map now says
    // idle, but the tab still shows busy (session.idle event lost).
    check('C', 'precondition: tab still stuck busy', (await busyDot.count()) > 0);
    const cBefore = (await stateOf()).messages[SID];
    await ctl({ statusBusy: false, dropSse: true }); // stream drops, engine idle
    // reconnect → onopen → catchUp(): busy=false from status + refetchNow
    const dotGone = await poll(async () => (await busyDot.count()) === 0, 12000);
    if (!dotGone) {
      console.log('  [debug] tabbar:', await page.locator('.tabbar').innerHTML().catch(() => '?'));
      console.log('  [debug] state:', JSON.stringify(await stateOf()));
    }
    await poll(async () => (await stateOf()).messages[SID] > cBefore, 8000).catch(() => 0);
    const cAfter = (await stateOf()).messages[SID];
    check('C', 'stuck busy cleared from status on reconnect', dotGone);
    check('C', 'messages refetched for the open tab', cAfter > cBefore, `${cBefore} → ${cAfter}`);
    await screenshot(page, 'sse-resilience-healed');

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
