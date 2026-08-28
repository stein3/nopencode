// verify-stall-retry.mjs — headless regression for the webui auto-retry
// nudge-vs-resend semantics (lib/retries.ts). Runs against an EMBEDDED fake
// engine (same pattern as verify-question.mjs: serve webui/dist + stub /oc
// endpoints + scripted SSE), so no live engine/chatserver is needed.
//
// Semantics under test: arming happens ONLY from a witnessed SSE
// session.error(isRetryable), which proves the engine accepted the original
// prompt_async — the turn ran, then the provider died. So every retry fires
// the short STALL_NUDGE ("the session stalled, continue.") instead of
// duplicating the original user prompt; a verbatim resend is reserved for
// undelivered dispatches.
//
// Cases:
//   A. arm on witnessed retryable error → first fire posts the NUDGE, never
//      the original text; retryline shows "attempt 1 · continue-nudge"
//   B. clean session.idle after a dispatch clears the loop (retryline gone)
//   C. re-arm after the clear → attempt counter restarted AND still nudges
//   D. failNextPrompt → nudge POST gets 502 → loop reschedules → next fire
//      nudges AGAIN; retryline suffix shows "continue-nudge" while counting
//   E. manual send during a countdown cancels the loop: retryline disappears,
//      exactly one manual prompt lands, no further auto posts for ~3s
//   + throughout: the ORIGINAL user text is never re-posted by the loop
//
// Run:  node e2e/embedded/stall-retry.test.mjs

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, launchBrowser, screenshot, sleep, poll } from '../helpers/setup.mjs';

const PORT = 8136;
const BASE = `http://127.0.0.1:${PORT}`;
const SID = 'ses_stall01';
const USER_TEXT = 'write me a haiku about crabs';
const NUDGE = 'the session stalled, continue.';

// ============================== fake engine =================================

const state = {
  prompts: [], // captured prompt_async POSTs: { text, status }
  failNextPrompt: false, // next prompt_async answers 502 (dispatch death)
  counts: {}, // request path -> hit count
};
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

// seeded transcript: one user message whose text lastUserText() will find
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
      return json(res, { prompts: state.prompts, failNextPrompt: state.failNextPrompt, counts: state.counts });
    }
    if (p === '/__ctl') {
      const ctl = JSON.parse((await readBody(req)) || '{}');
      if (typeof ctl.failNextPrompt === 'boolean') state.failNextPrompt = ctl.failNextPrompt;
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

    // ---- prompt_async: record + scripted behavior ----------------------------
    if (p.startsWith('/oc/session/') && p.endsWith('/prompt_async') && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const text = body?.parts?.[0]?.text ?? '';
      if (state.failNextPrompt) {
        state.failNextPrompt = false;
        state.prompts.push({ text, status: 502 }); // dispatch death: any 5xx rejects oc.prompt
        return json(res, { error: 'bad gateway' }, 502);
      }
      state.prompts.push({ text, status: 204 });
      res.writeHead(204);
      res.end();
      return;
    }

    // ---- history (chatserver stubs) ------------------------------------------
    if (p === '/api/history/sessions') {
      return json(res, [
        {
          id: SID,
          title: 'stall-retry-probe',
          created: Date.now() - 120_000,
          updated: Date.now() - 30_000,
          message_count: 1,
          cost: 0,
        },
      ]);
    }
    if (p.endsWith('/errors')) {
      if (req.method === 'GET') return json(res, []);
      return json(res, { ok: true });
    }
    if (p.startsWith('/api/history/session/')) return json(res, []);

    // ---- engine stubs (order matters: /status before /session/{id}) ----------
    if (p === '/oc/session/status') return json(res, {});
    if (p.startsWith('/oc/session/') && p.endsWith('/message')) return json(res, MESSAGES);
    if (p.startsWith('/oc/session/')) return json(res, { id: SID, title: 'stall-retry-probe', revert: null });
    if (p === '/oc/session' && req.method === 'POST')
      return json(res, { id: SID, title: 'stall-retry-probe', revert: null });
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
const snap = () => fetch(`${BASE}/__state`).then((r) => r.json());

const RETRYABLE_ERR = {
  type: 'session.error',
  properties: {
    sessionID: SID,
    error: { name: 'APIError', data: { message: 'upstream 503', isRetryable: true } },
  },
};

// ================================ run =======================================

let serverPid = null;

try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  serverPid = server._handle ? process.pid : process.pid; // in-process server; closed via server.close()
  await snap(); // warm + sanity

  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const pane = page.locator('.tabpane[style*="flex"]');
  const retryline = pane.locator('.retryline');

  try {
    // domcontentloaded — networkidle never fires (SSE stays open)
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // tab auto-open picks the fixture session; wait until its user message is
    // rendered so lastUserText() has content
    await page.locator('.sidebar button.item', { hasText: 'stall-retry-probe' }).waitFor({ timeout: 15000 });
    await pane.locator('.msg', { hasText: USER_TEXT }).first().waitFor({ timeout: 15000 });

    // spec step 1: message.updated for the user message (triggers the debounced
    // refetch that keeps the synced transcript current)
    await ctl({ emit: { type: 'message.updated', properties: { info: { id: 'msg_u1', sessionID: SID, role: 'user' } } } });
    await sleep(600); // cover refetch debounce (350ms) + render

    // ---- A. witnessed retryable error arms the loop → NUDGE -----------------
    console.log('\nCASE A — armed on witnessed error: first fire nudges, never resends original');
    await ctl({ emit: RETRYABLE_ERR });
    const lineA = await poll(() => retryline.isVisible(), 2000, 50);
    check('A', 'retryline appears within ~1s of session.error', lineA);
    if (lineA) {
      const txt = (await retryline.innerText()).replace(/\s+/g, ' ');
      check('A', 'countdown shows "attempt 1"', /attempt\s*1\b/.test(txt), txt.trim());
      check('A', 'kind suffix shows "continue-nudge"', txt.includes('continue-nudge'), txt.trim());
    }
    const gotFirst = await poll(async () => (await snap()).prompts.length >= 1, 5000);
    const s1 = await snap();
    check('A', 'first fire POSTed within backoff window', gotFirst);
    check(
      'A',
      `prompts[0] === STALL_NUDGE (NOT the original)`,
      s1.prompts[0]?.text === NUDGE,
      JSON.stringify(s1.prompts[0]),
    );
    check(
      'A',
      'original user text never posted',
      s1.prompts.every((x) => x.text !== USER_TEXT),
      JSON.stringify(s1.prompts.map((x) => x.text)),
    );

    // ---- B. clean idle clears the loop ---------------------------------------
    console.log('\nCASE B — clean session.idle after dispatch clears the loop');
    await ctl({ emit: { type: 'session.idle', properties: { sessionID: SID } } });
    await sleep(300);
    check('B', 'retryline gone after clean idle', !(await retryline.isVisible()));

    // ---- C. re-arm: attempt counter restarted, still nudges ------------------
    console.log('\nCASE C — re-arm after clear: fresh attempt 1, second fire also nudges');
    await ctl({ emit: RETRYABLE_ERR });
    const lineC = await poll(() => retryline.isVisible(), 2000, 50);
    check('C', 'retryline reappears', lineC);
    if (lineC) {
      const txt = (await retryline.innerText()).replace(/\s+/g, ' ');
      // proves case B actually RESET the loop (clearRetry) — not just hid it
      check('C', 'attempt counter restarted at 1 (loop was cleared)', /attempt\s*1\b/.test(txt), txt.trim());
    }
    const gotSecond = await poll(async () => (await snap()).prompts.length >= 2, 5000);
    const s2 = await snap();
    check('C', 'second fire POSTed', gotSecond);
    check('C', 'prompts[1] is also the nudge', s2.prompts[1]?.text === NUDGE, JSON.stringify(s2.prompts[1]));

    // ---- D. failed dispatch → reschedule → nudge again -----------------------
    console.log('\nCASE D — failNextPrompt: dead nudge re-nudges on the next fire');
    await ctl({ failNextPrompt: true });
    await ctl({ emit: RETRYABLE_ERR }); // cur loop exists → kept, attempt 2 (2s delay)
    const lineD = await poll(() => retryline.isVisible(), 2000, 50);
    check('D', 'retryline counting down again (attempt 2)', lineD);
    if (lineD) {
      const txt = (await retryline.innerText()).replace(/\s+/g, ' ');
      check('D', 'suffix shows continue-nudge while counting down', txt.includes('continue-nudge'), txt.trim());
      await screenshot(page, 'stall-retry');
    }
    const gotFail = await poll(async () => (await snap()).prompts.some((x) => x.status === 502), 8000);
    const sFail = await snap();
    const failed = sFail.prompts.find((x) => x.status === 502);
    check('D', 'nudge POST hit the 502 fault', gotFail);
    check('D', 'the FAILED dispatch was also the nudge', failed?.text === NUDGE, JSON.stringify(failed));
    // catch → scheduleRetry (attempt 3, 3s) → next fire nudges again
    const gotThird = await poll(async () => (await snap()).prompts.length >= 4, 10000);
    const s3 = await snap();
    check('D', 'loop rescheduled and fired again after the failure', gotThird);
    check(
      'D',
      'post-failure fire is the nudge too (status 204)',
      s3.prompts[3]?.text === NUDGE && s3.prompts[3]?.status === 204,
      JSON.stringify(s3.prompts[3]),
    );
    check(
      'D',
      'every loop post so far is the nudge — original text NEVER re-posted',
      s3.prompts.every((x) => x.text === NUDGE),
      JSON.stringify(s3.prompts.map((x) => x.text)),
    );

    // ---- E. manual send cancels the countdown --------------------------------
    console.log('\nCASE E — manual send during countdown cancels the loop');
    await ctl({ emit: { type: 'session.idle', properties: { sessionID: SID } } }); // clean reset
    await sleep(300);
    const input = pane.locator('#composer-input');
    await input.fill('manual hello');
    await ctl({ emit: RETRYABLE_ERR }); // arm attempt 1 (1s delay)
    const lineE = await poll(() => retryline.isVisible(), 2000, 30);
    check('E', 'countdown armed before manual send', lineE);
    await input.press('Enter'); // submit → cancelRetry(sid) + manual prompt
    // NOTE: locator.isVisible() returns a Promise in this playwright-core —
    // negate AFTER awaiting, never as `!isVisible()` (negates the promise obj)
    const goneE = await poll(async () => !(await retryline.isVisible()), 2000, 50);
    check('E', 'retryline disappears immediately on manual send', goneE);
    const gotManual = await poll(async () => (await snap()).prompts.some((x) => x.text === 'manual hello'), 4000);
    const s4 = await snap();
    check('E', 'manual prompt landed', gotManual);
    const nudgeCount = s4.prompts.filter((x) => x.text === NUDGE).length;
    check(
      'E',
      'auto-fire did NOT race the cancel (still exactly 4 nudges)',
      nudgeCount === 4,
      `nudges=${nudgeCount} prompts=${JSON.stringify(s4.prompts.map((x) => x.text))}`,
    );
    const countAfterSend = s4.prompts.length;
    await sleep(3000);
    const s5 = await snap();
    check(
      'E',
      'no further auto posts for ~3s after cancel',
      s5.prompts.length === countAfterSend,
      `before=${countAfterSend} after=${s5.prompts.length}`,
    );
    check('E', 'retryline still gone after the observation window', !(await retryline.isVisible()));
    check(
      'E',
      'FINAL: original user text was never re-posted by the whole run',
      s5.prompts.every((x) => x.text !== USER_TEXT),
      JSON.stringify(s5.prompts.map((x) => x.text)),
    );
  } finally {
    await browser.close();
  }
} finally {
  // embedded in-process server — shut down via close(), no PID to kill
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
