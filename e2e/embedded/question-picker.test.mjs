// verify-question.mjs — headless regression for the webui question-tool picker
// + sidebar ask-dot. Runs against an EMBEDDED fake engine (same pattern as
// fake-engine.py: serve webui/dist + stub /oc endpoints + scripted SSE), so no
// live engine/chatserver is needed.
//
// Cases (locks in the 2026-08 QuestionPicker fixes):
//   A. seeded pending request renders the interactive picker inside its tool card
//   B. sidebar row shows .dot.ask AND computed red background (--err #f48771)
//   C. picks survive a background SSE event → debounced transcript refetch
//      (regression guard: reset is keyed on req.id, not prop identity)
//   D. submit gating: disabled until every question answered; exactly one reply
//      POST with {answers:[...]}; dot clears once GET /question turns []
//   E. single plain question answers immediately on option click (no submit btn)
//   F. reply endpoint 404 → picker stays interactive afterwards
//
// Run: node e2e/embedded/question-picker.test.mjs
//
// KNOWN PRODUCT BUGS surfaced by this script (reported, NOT fixed here):
//   BUG-1 QuestionPicker.svelte custom input has no bind:value/on:input
//         (shipped that way in 05155e5) → typed text never reaches `custom[]`;
//         typing alone can never enable submit nor appear in the reply payload.
//         Case D detects this and falls back to the option-toggle path so the
//         rest of the flow still gets exercised.
//   BUG-2 failed reply POST (404) produces an unhandled promise rejection and
//         NO error toast (answerQuestion has try/finally, no catch; no global
//         unhandledrejection handler). Case F asserts picker-stays-interactive
//         (which holds) and reports the missing toast.

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, launchBrowser, screenshot, SHOTS_DIR, sleep, poll } from '../helpers/setup.mjs';

const PORT = 8127;
const BASE = `http://127.0.0.1:${PORT}`;
const SID = 'ses_qprobe01';
const MSG_ID = 'msg_qfixture1';
const CALL_ID = 'call_qfixture1';

// ============================== fake engine =================================

const state = {
  questions: [], // current GET /oc/question fixture
  replies: [], // captured {id, body, status}
  rejects: [],
  failReply: false, // when true, reply endpoint answers 404
  counts: {}, // request path -> hit count (refetch assertions)
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

const REQ_MAIN = {
  id: 'qreq_main',
  sessionID: SID,
  questions: [
    {
      question: 'Which environments should get the fix?',
      header: 'Env',
      multiple: true,
      options: [
        { label: 'A', description: 'staging' },
        { label: 'B', description: 'canary' },
        { label: 'C', description: 'prod' },
      ],
    },
    {
      question: 'Codename for the release?',
      header: 'Name',
      custom: true,
      options: [
        { label: 'X', description: 'keep x' },
        { label: 'Y', description: 'why not' },
      ],
    },
  ],
  tool: { messageID: MSG_ID, callID: CALL_ID },
};

const REQ_PLAIN = {
  id: 'qreq_plain',
  sessionID: SID,
  questions: [
    {
      question: 'Proceed with rollback?',
      header: 'Go',
      options: [
        { label: 'Y', description: 'yes' },
        { label: 'Z', description: 'abort' },
      ],
    },
  ],
  tool: { messageID: MSG_ID, callID: CALL_ID },
};

const REQ_FAIL = { ...REQ_MAIN, id: 'qreq_fail' };

// one assistant message whose question tool part matches the pending request
// by callID (Transcript.findPending → QuestionPicker inside the tool card)
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
        id: 'part_q1',
        type: 'tool',
        tool: 'question',
        callID: CALL_ID,
        state: { status: 'running', input: { questions: REQ_MAIN.questions } },
      },
    ],
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
    let n = parseInt(req.headers['content-length'] || '0', 10);
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
        questions: state.questions.map((q) => q.id),
        replies: state.replies,
        rejects: state.rejects,
        failReply: state.failReply,
        counts: state.counts,
      });
    }
    if (p === '/__ctl') {
      const ctl = JSON.parse((await readBody(req)) || '{}');
      if (Array.isArray(ctl.questions)) state.questions = ctl.questions;
      if (typeof ctl.failReply === 'boolean') state.failReply = ctl.failReply;
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

    // ---- question endpoints --------------------------------------------------
    if (p === '/oc/question') return json(res, state.questions);
    const mReply = p.match(/^\/oc\/question\/([^/]+)\/reply$/);
    if (mReply && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (state.failReply) {
        state.replies.push({ id: mReply[1], body, status: 404 });
        return json(res, { error: 'QuestionNotFoundError' }, 404);
      }
      state.replies.push({ id: mReply[1], body, status: 200 });
      state.questions = []; // answered request leaves the registry
      return json(res, {});
    }
    const mReject = p.match(/^\/oc\/question\/([^/]+)\/reject$/);
    if (mReject && req.method === 'POST') {
      state.rejects.push({ id: mReject[1], status: state.failReply ? 404 : 200 });
      if (!state.failReply) state.questions = [];
      return json(res, {});
    }

    // ---- history (chatserver stubs) ------------------------------------------
    if (p === '/api/history/sessions') {
      return json(res, [
        {
          id: SID,
          title: 'question-probe',
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
    if (p.startsWith('/oc/session/')) return json(res, { id: SID, title: 'question-probe', revert: null });
    if (p === '/oc/session' && req.method === 'POST')
      return json(res, { id: SID, title: 'question-probe', revert: null });
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

// ================================ run =======================================

const RED = 'rgb(244, 135, 113)'; // var(--err) from app.css

try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  await snap(); // warm + sanity

  // seed the pending request BEFORE page load: startEvents() pulls /oc/question
  // at startup, so the ask-dot and picker are live from the first paint
  await ctl({ questions: [REQ_MAIN] });

  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const pane = page.locator('.tabpane[style*="flex"]');

  try {
    // domcontentloaded — networkidle never fires (SSE stays open)
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // ---- A. picker renders for the seeded request ---------------------------
    console.log('\nCASE A — seeded request renders interactive picker');
    const row = page.locator('.sidebar button.item', { hasText: 'question-probe' });
    await row.waitFor({ timeout: 15000 });
    const qpick = pane.locator('.qpick');
    await qpick.waitFor({ timeout: 15000 });
    check('A', 'picker visible in tool card of seeded assistant msg', await qpick.isVisible());
    const qas = qpick.locator('.qa');
    check('A', 'both questions rendered', (await qas.count()) === 2);
    const qq1 = (await qas.nth(0).locator('.qq').innerText()).trim();
    const qq2 = (await qas.nth(1).locator('.qq').innerText()).trim();
    check(
      'A',
      'question texts + headers',
      qq1.startsWith('Env: Which environments') && qq2.startsWith('Name: Codename'),
      `${JSON.stringify(qq1)} / ${JSON.stringify(qq2)}`,
    );
    check(
      'A',
      '"awaiting your answer" badge on tool summary',
      await pane.locator('.toolcard .qwait').first().isVisible(),
    );

    // ---- B. sidebar ask dot --------------------------------------------------
    console.log('\nCASE B — sidebar red ask dot');
    const dot = row.locator('.dot');
    const dotClass = await dot.getAttribute('class');
    check('B', 'row dot has class "ask"', /\bask\b/.test(dotClass ?? ''), dotClass ?? '');
    const bg = await dot.evaluate((el) => getComputedStyle(el).backgroundColor);
    check('B', `computed background is --err red (${RED})`, bg === RED, bg);

    // ---- C. picks survive background refetch --------------------------------
    console.log('\nCASE C — picks survive SSE-triggered refetch (fix #1)');
    const qa0opts = qas.nth(0).locator('button.opt'); // A, B, C
    await qa0opts.nth(0).click();
    await qa0opts.nth(1).click();
    await page.waitForTimeout(150);
    const pickedAfterClicks = await qa0opts.evaluateAll((els) =>
      els.map((e) => e.classList.contains('picked')),
    );
    check('C', 'A and B both .picked after toggling', JSON.stringify(pickedAfterClicks) === '[true,true,false]');
    await screenshot(page, 'question-picker');

    // background churn for S1 → setMeta swap + debounced refetch (350ms)
    const before = (await snap()).counts[`/oc/session/${SID}/message`] ?? 0;
    await ctl({
      emit: { type: 'message.updated', properties: { info: { id: MSG_ID, sessionID: SID } } },
    });
    await poll(async () => ((await snap()).counts[`/oc/session/${SID}/message`] ?? 0) > before, 4000);
    await sleep(700); // cover the debounce + re-render
    const pickedAfterRefetch = await qa0opts.evaluateAll((els) =>
      els.map((e) => e.classList.contains('picked')),
    );
    check(
      'C',
      'A+B STILL picked after message.updated refetch (~700ms)',
      JSON.stringify(pickedAfterRefetch) === '[true,true,false]',
      `refetch happened: ${(await snap()).counts[`/oc/session/${SID}/message`] ?? 0} > ${before}`,
    );

    // ---- D. submit gating, reply payload, dot clears -------------------------
    console.log('\nCASE D — submit gating + reply POST + dot clears');
    const sendBtn = qpick.locator('button.send');
    check('D', 'submit button exists', (await sendBtn.count()) === 1);
    check('D', 'submit disabled while unanswered', await sendBtn.isDisabled());

    // BUG-1 probe: typing alone must enable submit (custom text counts as answer)
    await qpick.locator('input.custom').fill('my-custom-answer');
    const enabledByTyping = await poll(() => sendBtn.isEnabled(), 1200);
    check(
      'D',
      'typing custom text enables submit',
      enabledByTyping,
      enabledByTyping ? '' : 'PRODUCT BUG-1: custom input has no value binding — typed text ignored',
    );

    let expectAnswers;
    if (enabledByTyping) {
      expectAnswers = [['A', 'B'], ['my-custom-answer']];
    } else {
      // fallback through the working toggle path so the reply flow still runs
      await qas.nth(1).locator('button.opt').nth(0).click(); // X
      await poll(() => sendBtn.isEnabled(), 2000);
      expectAnswers = [['A', 'B'], ['X']];
    }
    check('D', 'submit enabled once every question answered', await sendBtn.isEnabled());
    await sendBtn.click();

    let repliedOk = false;
    let capturedBody = null;
    repliedOk = await poll(async () => {
      const s = await snap();
      capturedBody = s.replies[0]?.body;
      return s.replies.length === 1;
    }, 5000);
    check('D', 'exactly ONE reply POST captured', repliedOk, JSON.stringify(capturedBody));
    check(
      'D',
      `reply body answers === ${JSON.stringify(expectAnswers)}`,
      JSON.stringify(capturedBody?.answers) === JSON.stringify(expectAnswers),
      capturedBody ? `got ${JSON.stringify(capturedBody.answers)}` : 'no body',
    );

    // engine registry empties → refreshQuestions clears store → picker + dot go
    await qpick.waitFor({ state: 'detached', timeout: 8000 });
    check('D', 'picker removed after GET /question flips to []', true);
    await sleep(250);
    const dotClass2 = await row.locator('.dot').getAttribute('class');
    const bg2 = await row.locator('.dot').evaluate((el) => getComputedStyle(el).backgroundColor);
    check(
      'D',
      'sidebar ask dot cleared (class + computed)',
      !/\bask\b/.test(dotClass2 ?? '') && bg2 === 'rgba(0, 0, 0, 0)',
      `class="${dotClass2}" bg=${bg2}`,
    );
    await screenshot(page, 'question-cleared');

    // ---- E. single plain question answers immediately ------------------------
    console.log('\nCASE E — plain single question: click = instant reply');
    await ctl({
      questions: [REQ_PLAIN],
      emit: { type: 'question.asked', properties: { sessionID: SID } },
    });
    const qpickE = pane.locator('.qpick');
    await page.locator('.qpick .qq', { hasText: 'Proceed with rollback?' }).waitFor({ timeout: 8000 });
    check('E', 'picker re-rendered for new request', await qpickE.isVisible());
    check('E', 'NO submit button for single plain question', (await qpickE.locator('button.send').count()) === 0);
    await qpickE.locator('button.opt', { hasText: 'Z' }).click();
    let ePosted = false;
    ePosted = await poll(async () => {
      const s = await snap();
      return s.replies.length === 2 && JSON.stringify(s.replies[1].body.answers) === '[["Z"]]';
    }, 5000);
    const st = await snap();
    check(
      'E',
      'option click alone posted [["Z"]] immediately',
      ePosted,
      ePosted ? '' : `replies=${JSON.stringify(st.replies.map((r) => r.body))}`,
    );
    await qpickE.waitFor({ state: 'detached', timeout: 8000 });

    // ---- F. failed reply keeps picker usable ---------------------------------
    console.log('\nCASE F — reply endpoint 404: error surfacing + interactivity');
    await ctl({
      failReply: true,
      questions: [REQ_FAIL],
      emit: { type: 'question.asked', properties: { sessionID: SID } },
    });
    const qpickF = pane.locator('.qpick');
    await page.locator('.qpick .qq', { hasText: 'Which environments' }).waitFor({ timeout: 8000 });
    const fOpts = qpickF.locator('.qa').nth(0).locator('button.opt'); // A B C
    await fOpts.nth(0).click();
    await fOpts.nth(1).click();
    await qpickF.locator('.qa').nth(1).locator('button.opt').nth(0).click(); // X
    await poll(() => qpickF.locator('button.send').isEnabled(), 2000);
    await qpickF.locator('button.send').click();
    const failSeen = await poll(async () => {
      const s = await snap();
      return s.replies.some((r) => r.status === 404);
    }, 5000);
    check('F', 'reply POST hit the stub and got 404', failSeen);
    await sleep(500); // toast lifetime is 2600ms — look promptly
    const toastCount = await page.locator('.toast').count();
    check(
      'F',
      'error toast visible after failed submit',
      toastCount > 0,
      toastCount ? '' : 'PRODUCT BUG-2: no toast — answerQuestion rejection is unhandled (no catch, no global handler)',
    );
    const fPicked = await fOpts.evaluateAll((els) => els.map((e) => e.classList.contains('picked')));
    const fEnabled = await poll(() => qpickF.locator('button.send').isEnabled(), 2000);
    check(
      'F',
      'picker still interactive after failure (busy reset, picks intact)',
      JSON.stringify(fPicked) === '[true,true,false]' && fEnabled,
      `picked=${JSON.stringify(fPicked)} sendEnabled=${fEnabled}`,
    );
    await screenshot(page, 'question-error');

    // recovery proves full interactivity: clear the fault, resubmit succeeds
    await ctl({ failReply: false });
    await qpickF.locator('button.send').click();
    const recovered = await poll(async () => {
      const s = await snap();
      return s.replies.length >= 3 && s.replies.at(-1).status === 200;
    }, 5000);
    check('F', 'resubmit after clearing fault succeeds (interactive end-to-end)', recovered);
    await qpickF.waitFor({ state: 'detached', timeout: 8000 });
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
if (fails) {
  console.log('\nNOTE: failing checks annotated "PRODUCT BUG" are webui defects to fix in');
  console.log('webui/src/components/QuestionPicker.svelte (see file header) — not harness issues.');
}
process.exitCode = fails ? 1 : 0;
