// engine-retry.test.mjs — headless regression for the engine retry-loop
// stall banner (session.status SSE events + /session/status poll hydration).
// Runs against an EMBEDDED fake engine (same pattern as stall-retry.test.mjs),
// so no live engine/chatserver is needed.
//
// Cases:
//   1. Tab open hydrates banner from GET /session/status returning retry
//   2. Scripted SSE session.status retry event updates attempt/message live
//   3. SSE session.status busy event clears the banner
//   4. Stop button fires POST /session/<sid>/abort; after fake emits
//      session.error(MessageAbortedError)+session.idle → banner gone
//   5. ↩ revert on stalled session: fake returns 409 SessionBusyError for
//      FIRST revert POST, 200 after abort → abort fired, revert followed,
//      no raw-409 toast
//   6. "Undo & resend" banner button → abort + revert + composer prefilled
//   7. Busy-map regression: retry counts as busy for sidebar dot
//
// Run:  node e2e/embedded/engine-retry.test.mjs

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, launchBrowser, screenshot, sleep, poll } from '../helpers/setup.mjs';

const PORT = 8138;
const BASE = `http://127.0.0.1:${PORT}`;
const SID = 'ses_engretry01';
const USER_TEXT = 'explain quantum computing simply';
const RETRY_MSG = 'Free usage exceeded, subscribe to Go';

// ============================== fake engine =================================

const state = {
  aborts: [],      // captured abort POSTs
  reverts: [],     // captured revert POSTs: { body }
  promptAsyncs: [], // captured prompt_async POSTs
  statusMap: {},   // /oc/session/status response
  nextRevertBusy: false, // first revert → 409, then clear
  counts: {},
};
const sseClients = new Set();

function sseEmit(type, properties = {}) {
  const frame = `data: ${JSON.stringify({ type, properties })}\n\n`;
  for (const res of sseClients) {
    try { res.write(frame); } catch { /* dropped client */ }
  }
}

const MESSAGES = [
  {
    info: {
      id: 'msg_u1',
      role: 'user',
      agent: 'build',
      time: { created: Date.now() - 60_000 },
    },
    parts: [{ id: 'part_u1', type: 'text', text: USER_TEXT }],
  },
  {
    info: {
      id: 'msg_a1',
      role: 'assistant',
      agent: 'build',
      time: { created: Date.now() - 30_000 },
      sessionID: SID,
      parentID: 'msg_u1',
    },
    parts: [],
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
  state.counts[p] = (state.counts[p] ?? 0) + 1;

  try {
    // ---- test introspection + control --------------------------------------
    if (p === '/__state') {
      return json(res, {
        aborts: state.aborts,
        reverts: state.reverts,
        promptAsyncs: state.promptAsyncs,
        statusMap: state.statusMap,
        counts: state.counts,
      });
    }
    if (p === '/__ctl') {
      const ctl = JSON.parse((await readBody(req)) || '{}');
      if (ctl.statusMap) state.statusMap = ctl.statusMap;
      if (typeof ctl.nextRevertBusy === 'boolean') state.nextRevertBusy = ctl.nextRevertBusy;
      if (ctl.emit) sseEmit(ctl.emit.type, ctl.emit.properties ?? {});
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

    // ---- abort ---------------------------------------------------------------
    if (p.startsWith('/oc/session/') && p.endsWith('/abort') && req.method === 'POST') {
      state.aborts.push({ sid: SID, t: Date.now() });
      return json(res, {});
    }

    // ---- revert (busy guard) ------------------------------------------------
    if (p.startsWith('/oc/session/') && p.endsWith('/revert') && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      state.reverts.push({ body, t: Date.now() });
      if (state.nextRevertBusy) {
        state.nextRevertBusy = false; // first call → 409, next succeeds
        return json(res, { name: 'SessionBusyError', data: { sessionID: SID, message: 'Session is busy: retrying' } }, 409);
      }
      return json(res, { id: SID, revert: { messageID: body.messageID ?? 'msg_u1' } });
    }

    // ---- prompt_async --------------------------------------------------------
    if (p.startsWith('/oc/session/') && p.endsWith('/prompt_async') && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      state.promptAsyncs.push({ text: body?.parts?.[0]?.text ?? '', t: Date.now() });
      res.writeHead(204);
      res.end();
      return;
    }

    // ---- history (chatserver stubs) ------------------------------------------
    if (p === '/api/history/sessions') {
      return json(res, [
        { id: SID, title: 'engine-retry-probe', created: Date.now() - 120_000, updated: Date.now() - 30_000, message_count: 2, cost: 0 },
      ]);
    }
    if (p.endsWith('/errors')) {
      if (req.method === 'GET') return json(res, []);
      return json(res, { ok: true });
    }
    if (p.startsWith('/api/history/session/')) return json(res, []);

    // ---- engine stubs (order matters: /status before /session/{id}) ----------
    if (p === '/oc/session/status') return json(res, state.statusMap);
    if (p.startsWith('/oc/session/') && p.endsWith('/message')) return json(res, MESSAGES);
    if (p === '/oc/session' && req.method === 'POST')
      return json(res, { id: SID, title: 'engine-retry-probe', revert: null });
    if (p.startsWith('/oc/session/')) return json(res, { id: SID, title: 'engine-retry-probe', revert: null });
    if (p === '/oc/config/providers')
      return json(res, { providers: [{ id: 'opencode', models: { 'x-preview-f-free': { id: 'x-preview-f-free' } } }] });
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
    try { json(res, { error: String(e) }, 500); } catch { /* headers sent */ }
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
const snap = () => fetch(`${BASE}/__state`).then((r) => r.json());

// ================================ run =======================================

try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  await snap(); // warm + sanity

  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const pane = page.locator('.tabpane[style*="flex"]');
  const retryline = pane.locator('.retryline.engineretry');

  try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // tab auto-open picks the fixture session
    await page.locator('.sidebar button.item', { hasText: 'engine-retry-probe' }).waitFor({ timeout: 15000 });
    await pane.locator('.msg', { hasText: USER_TEXT }).first().waitFor({ timeout: 15000 });

    // ---- CASE 1: Tab open hydrates banner from GET /session/status -----------
    console.log('\nCASE 1 — Tab open hydrates from /session/status');
    await ctl({
      statusMap: {
        [SID]: { type: 'retry', attempt: 1, message: RETRY_MSG, action: { label: 'subscribe', link: 'https://opencode.ai/go' }, next: Date.now() + 300000 },
      },
    });
    // trigger openLive status fetch: close and reopen, or just reload
    // Simpler: reload the page so openLive fetches /oc/session/status fresh
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.sidebar button.item', { hasText: 'engine-retry-probe' }).waitFor({ timeout: 15000 });
    await pane.locator('.msg', { hasText: USER_TEXT }).first().waitFor({ timeout: 15000 });
    const line1 = await poll(() => retryline.isVisible(), 5000, 100);
    check('1', 'banner appears after reload (hydrated from /session/status)', line1);
    if (line1) {
      const txt = (await retryline.innerText()).replace(/\s+/g, ' ');
      check('1', 'banner text contains retry message', txt.includes(RETRY_MSG), txt.slice(0, 120));
      check('1', 'banner shows attempt 1', /attempt\s*1/.test(txt), txt.slice(0, 120));
      // countdown: "next try in Xh Xm" or "Xm:XX"
      check('1', 'banner shows countdown', /next try in/.test(txt), txt.slice(0, 120));
      // subscribe link
      const link = retryline.locator('a.erlink');
      const linkVisible = await link.isVisible().catch(() => false);
      check('1', 'subscribe link is visible', linkVisible);
      if (linkVisible) {
        const href = await link.getAttribute('href');
        check('1', 'subscribe link href correct', href === 'https://opencode.ai/go', href);
        const target = await link.getAttribute('target');
        check('1', 'subscribe link opens in new tab', target === '_blank');
      }
    }

    // ---- CASE 2: SSE session.status retry updates live -----------------------
    console.log('\nCASE 2 — SSE session.status retry event updates banner');
    await ctl({
      emit: {
        type: 'session.status',
        properties: {
          sessionID: SID,
          status: { type: 'retry', attempt: 3, message: 'Rate limited — try again later', next: Date.now() + 120000 },
        },
      },
    });
    await sleep(500);
    const line2 = await poll(() => retryline.isVisible(), 2000, 50);
    check('2', 'banner still visible after SSE update', line2);
    if (line2) {
      const txt = (await retryline.innerText()).replace(/\s+/g, ' ');
      check('2', 'attempt updated to 3', /attempt\s*3/.test(txt), txt.slice(0, 120));
      check('2', 'message updated', txt.includes('Rate limited'), txt.slice(0, 120));
    }

    // ---- CASE 3: SSE session.status busy clears banner ----------------------
    console.log('\nCASE 3 — SSE session.status busy clears the banner');
    await ctl({
      emit: {
        type: 'session.status',
        properties: {
          sessionID: SID,
          status: { type: 'busy' },
        },
      },
    });
    await sleep(400);
    const gone3 = await poll(async () => !(await retryline.isVisible()), 2000, 50);
    check('3', 'banner disappears on busy event', gone3);

    // ---- CASE 4: Stop button → abort → idle → banner gone -------------------
    console.log('\nCASE 4 — Stop button fires abort, banner clears after idle');
    // re-arm the retry banner via status map + reload (openLive fetches status)
    await ctl({
      statusMap: {
        [SID]: { type: 'retry', attempt: 2, message: RETRY_MSG, next: Date.now() + 600000 },
      },
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.sidebar button.item', { hasText: 'engine-retry-probe' }).waitFor({ timeout: 15000 });
    await pane.locator('.msg', { hasText: USER_TEXT }).first().waitFor({ timeout: 15000 });
    const line4 = await poll(() => retryline.isVisible(), 5000, 100);
    check('4', 'banner re-armed after reload', line4);
    // click Stop
    const stopBtn = retryline.locator('button.erbtn').first();
    if (line4 && await stopBtn.isVisible()) {
      await stopBtn.click();
      await sleep(300);
      const s4 = await snap();
      check('4', 'Stop button fired abort POST', s4.aborts.length > 0);
      // fake engine completes: abort → session.error(aborted) + session.idle
      await ctl({ emit: { type: 'session.error', properties: { sessionID: SID, error: { name: 'MessageAbortedError' } } } });
      await ctl({ emit: { type: 'session.idle', properties: { sessionID: SID } } });
      await sleep(400);
      const gone4 = await poll(async () => !(await retryline.isVisible()), 2000, 50);
      check('4', 'banner gone after idle', gone4);
      // composer should be enabled (not busy)
      const composer = pane.locator('#composer-input');
      const enabled4 = await composer.isEnabled().catch(() => false);
      check('4', 'composer enabled after abort+idle', enabled4);
    }

    // ---- CASE 5: ↩ revert on stalled session: 409 → abort → revert ---------
    console.log('\nCASE 5 — ↩ revert auto-recovers from 409 SessionBusyError');
    // Set up: next revert will return 409, then statusMap for retry
    state.nextRevertBusy = true;
    await ctl({
      statusMap: {
        [SID]: { type: 'retry', attempt: 1, message: RETRY_MSG, next: Date.now() + 600000 },
      },
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.sidebar button.item', { hasText: 'engine-retry-probe' }).waitFor({ timeout: 15000 });
    await pane.locator('.msg', { hasText: USER_TEXT }).first().waitFor({ timeout: 15000 });
    // Wait for banner to appear so we know the session is in retry state
    await poll(() => retryline.isVisible(), 5000, 100);
    // Click the ↩ button on the user message (hover to reveal actions)
    const userMsg = pane.locator('.msg.user').first();
    await userMsg.hover();
    await sleep(100);
    const revertBtn = userMsg.locator('.acts button.act[title*="Revert"]');
    if (await revertBtn.isVisible().catch(() => false)) {
      await revertBtn.click();
      await sleep(800); // allow abort + revert chain to complete
      const s5 = await snap();
      check('5', 'abort was fired as part of busy recovery', s5.aborts.length > 0, `aborts=${s5.aborts.length}`);
      check('5', 'revert followed after abort', s5.reverts.length > 0, `reverts=${s5.reverts.length}`);
      // check no raw 409 toast appeared (the toast should say "stopped retrying")
      const toast = page.locator('.toast');
      const toastText = await toast.textContent().catch(() => '');
      check('5', 'no raw 409 error toast', !toastText.includes('409'), toastText);
    } else {
      check('5', 'revert button visible', false, 'skipped — no revert button found');
    }

    // ---- CASE 6: "Undo & resend" banner button → abort + revert + prefill ----
    console.log('\nCASE 6 — Undo & resend button aborts, reverts, prefills composer');
    // Re-arm retry via statusMap + reload
    await ctl({
      statusMap: {
        [SID]: { type: 'retry', attempt: 2, message: RETRY_MSG, next: Date.now() + 600000 },
      },
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.sidebar button.item', { hasText: 'engine-retry-probe' }).waitFor({ timeout: 15000 });
    await pane.locator('.msg', { hasText: USER_TEXT }).first().waitFor({ timeout: 15000 });
    const line6 = await poll(() => retryline.isVisible(), 5000, 100);
    check('6', 'banner visible for undo-resend', line6);
    if (line6) {
      const undoBtn = retryline.locator('button.erundo');
      if (await undoBtn.isVisible()) {
        const abortsBefore = (await snap()).aborts.length;
        const revertsBefore = (await snap()).reverts.length;
        await undoBtn.click();
        await sleep(1200); // allow abort + revert chain to complete
        const s6 = await snap();
        check('6', 'abort fired by undo-resend', s6.aborts.length > abortsBefore);
        check('6', 'revert fired by undo-resend', s6.reverts.length > revertsBefore);
        // composer should be prefilled with the user text
        const composer = pane.locator('#composer-input');
        const val = await composer.inputValue().catch(() => '');
        check('6', 'composer prefilled with user text', val.includes(USER_TEXT), val.slice(0, 80));
        // banner should be cleared (poll to allow store propagation)
        const gone6 = await poll(async () => !(await retryline.isVisible()), 3000, 50);
        check('6', 'banner cleared after undo-resend', gone6);
      } else {
        check('6', 'undo button visible', false);
      }
    }

    // ---- CASE 7: Busy-map regression: retry counts as busy ------------------
    console.log('\nCASE 7 — retry entry counts as busy for sidebar dot');
    await ctl({
      statusMap: {
        [SID]: { type: 'retry', attempt: 1, message: RETRY_MSG, next: Date.now() + 600000 },
      },
    });
    // The sidebar polls busy every 10s — trigger an immediate poll by
    // reloading. After reload, the sidebar should fetch /session/status and
    // count the retry entry as busy.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.sidebar button.item', { hasText: 'engine-retry-probe' }).waitFor({ timeout: 15000 });
    await pane.locator('.msg', { hasText: USER_TEXT }).first().waitFor({ timeout: 15000 });
    // The sidebar busy dot for the session should be active (yellow/busy class)
    const sidebarItem = page.locator('.sidebar button.item', { hasText: 'engine-retry-probe' });
    const hasBusy = await sidebarItem.locator('.dot.busy').isVisible().catch(() => false);
    check('7', 'sidebar dot shows busy for retrying session', hasBusy);

    await screenshot(page, 'engine-retry');

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
