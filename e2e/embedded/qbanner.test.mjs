// qbanner.test.mjs — smoke for the "questions pending" banner (QuestionBanner.svelte).
// Runs against an EMBEDDED fake engine (same pattern as question-picker.mjs).
//
// Cases:
//   A. banner shows "N questions awaiting your answer · <first header>"
//   B. click scrolls the question card's message row into view (Tab.jumpTo)
//   C. banner disappears when the pending list drains (SSE drop → refreshQuestions)
//
// Run: node e2e/embedded/qbanner.test.mjs

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, launchBrowser, screenshot, SHOTS_DIR } from '../helpers/setup.mjs';

const PORT = 8157;
const BASE = `http://127.0.0.1:${PORT}`;
const SID = 'ses_qbanner';
const MSG_ID = 'msg_qbanner1';
const CALL_ID = 'call_qbanner1';
const MSG_ID2 = 'msg_qbanner2';
const CALL_ID2 = 'call_qbanner2';

// ============================== fake engine =================================

const state = {
  questions: [],          // current GET /oc/question fixture
  replies: [],            // captured reply POSTs
  counts: {},
};
const sseClients = new Set();

function sseEmit(type, properties = {}) {
  const frame = `data: ${JSON.stringify({ type, properties })}\n\n`;
  for (const res of sseClients) {
    try { res.write(frame); } catch { /* dropped */ }
  }
}

const REQ1 = {
  id: 'qbann-1',
  sessionID: SID,
  questions: [{ header: 'Deployment target 1', question: 'Where should we deploy?', options: [{ label: 'staging' }, { label: 'prod' }] }],
  tool: { messageID: MSG_ID, callID: CALL_ID },
};

const REQ2 = {
  id: 'qbann-2',
  sessionID: SID,
  questions: [{ header: 'Deployment target 2', question: 'And the second one?', options: [{ label: 'a' }] }],
  tool: { messageID: MSG_ID2, callID: CALL_ID2 },
};

// Filler messages to push the targets above the viewport
const FILLERS = [];
for (let i = 1; i <= 24; i++) {
  FILLERS.push({
    info: { id: `msg_fill_${i}`, role: 'user', time: { created: Date.now() - 120_000 + i * 1000 } },
    parts: [{ id: `part_fill_${i}`, type: 'text', text: `filler row ${i} — keep the transcript taller than the viewport` }],
  });
}

const TARGET_MSG1 = {
  info: { id: MSG_ID, role: 'assistant', agent: 'build', modelID: 'x-preview-f-free', providerID: 'opencode', time: { created: Date.now() - 90_000 } },
  parts: [
    {
      id: 'part_q1', type: 'tool', tool: 'question', callID: CALL_ID,
      state: { status: 'running', input: { questions: REQ1.questions } },
    },
  ],
};

const TARGET_MSG2 = {
  info: { id: MSG_ID2, role: 'assistant', agent: 'build', modelID: 'x-preview-f-free', providerID: 'opencode', time: { created: Date.now() - 85_000 } },
  parts: [
    {
      id: 'part_q2', type: 'tool', tool: 'question', callID: CALL_ID2,
      state: { status: 'running', input: { questions: REQ2.questions } },
    },
  ],
};

const ALL_MESSAGES = [...FILLERS, TARGET_MSG1, TARGET_MSG2];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript',
  '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.map': 'application/json', '.txt': 'text/plain',
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
        questions: state.questions.map((q) => q.id),
        replies: state.replies,
        counts: state.counts,
      });
    }
    if (p === '/__ctl') {
      const ctl = JSON.parse((await readBody(req)) || '{}');
      if (Array.isArray(ctl.questions)) state.questions = ctl.questions;
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
      state.replies.push({ id: mReply[1], body, status: 200 });
      // Answered requests leave the registry
      state.questions = state.questions.filter((q) => q.id !== mReply[1]);
      return json(res, {});
    }

    // ---- history (chatserver stubs) ------------------------------------------
    if (p === '/api/history/sessions') {
      return json(res, [{
        id: SID, title: 'Question banner smoke', created: Date.now() - 300_000,
        updated: Date.now() - 10_000, message_count: ALL_MESSAGES.length, cost: 0,
      }]);
    }
    if (p.endsWith('/errors')) {
      if (req.method === 'GET') return json(res, []);
      return json(res, { ok: true });
    }
    if (p.startsWith('/api/history/session/')) return json(res, []);

    // ---- engine stubs --------------------------------------------------------
    if (p === '/oc/session/status') return json(res, {});
    if (p.startsWith('/oc/session/') && p.endsWith('/message')) return json(res, ALL_MESSAGES);
    if (p.startsWith('/oc/session/')) return json(res, { id: SID, title: 'Question banner smoke', revert: null });
    if (p === '/oc/session' && req.method === 'POST')
      return json(res, { id: SID, title: 'Question banner smoke', revert: null });
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
    res.writeHead(200, { 'Content-Type': ct, 'Content-Length': b.length, 'Cache-Control': 'no-store' });
    res.end(b);
  } catch (e) {
    try { json(res, { error: String(e) }, 500); } catch { /* SSE */ }
  }
});

// ================================ helpers ====================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ctl = (payload) =>
  fetch(`${BASE}/__ctl`, { method: 'POST', body: JSON.stringify(payload) }).then((r) => r.json());
const snap = () => fetch(`${BASE}/__state`).then((r) => r.json());

const results = [];
let pageErrors = [];

function check(c, name, pass, note = '') {
  results.push({ c, name, pass: !!pass, note });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${c} · ${name}${note ? ` — ${note}` : ''}`);
}

// ================================ run ========================================

try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  await snap(); // warm

  // Seed both pending requests before page load
  await ctl({ questions: [REQ1, REQ2] });

  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const pane = page.locator('.tabpane[style*="flex"]');

  try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // ---- A. banner shows correct count + first header ------------------------
    console.log('\nCASE A — banner count + header');
    const banner = page.locator('.tabpane[style*="flex"] .qbanner');
    await banner.waitFor({ timeout: 15000 });
    const txt = (await banner.textContent()) ?? '';
    check('A', 'banner shows "2 questions awaiting your answer"',
      /2 questions awaiting your answer/.test(txt),
      `text: ${txt.trim().slice(0, 80)}`);
    check('A', 'shows FIRST request header "Deployment target 1"',
      txt.includes('Deployment target 1'));
    check('A', 'no exclamation marks', !txt.includes('!'));
    await screenshot(page, 'qbanner');

    // ---- B. scroll away, then click to jump ----------------------------------
    console.log('\nCASE B — click jumps to question card');
    const transcript = pane.locator('.transcript');
    const pb = await transcript.boundingBox();
    await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
    await page.mouse.wheel(0, -900);
    await page.waitForTimeout(400);

    const before = await page.locator(`#m-${MSG_ID}`).boundingBox();
    check('B', `target row offscreen after wheel-up (y=${before?.y})`,
      !before || before.y >= 800 || before.y < 0);

    await banner.click();
    await page.waitForTimeout(700);
    const after = await page.locator(`#m-${MSG_ID}`).boundingBox();
    check('B', `jump parked target row in view (y=${after?.y})`,
      after && after.y >= 0 && after.y < 800);
    await screenshot(page, 'qbanner-jumped');

    // ---- C. banner disappears when questions drain ---------------------------
    console.log('\nCASE C — banner disappears when nothing pending');
    await ctl({ questions: [], emit: { type: 'question.replied' } });
    // Give the SSE event time to propagate + refreshQuestions to fire
    let gone = false;
    for (let i = 0; i < 40; i++) {
      if ((await page.locator('.qbanner').count()) === 0) { gone = true; break; }
      await sleep(300);
    }
    check('C', 'banner disappears once nothing pends', gone);

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
  if (!r.pass) fails++;
}
if (pageErrors.length) {
  console.log(`\npage errors observed (${pageErrors.length}):`);
  for (const e of [...new Set(pageErrors)].slice(0, 5)) console.log('  •', e.slice(0, 220));
}
console.log('Checks:', results.length, '| failed:', fails);
process.exitCode = fails ? 1 : 0;
