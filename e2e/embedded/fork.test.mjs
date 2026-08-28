// fork.test.mjs — embedded fake-engine test for the session fork button
//
// Verifies: fork button visible on user messages; clicking fork creates a new
// tab with the subset of messages before the clicked one; original session
// intact; composer prefilled with the forked-from text.
//
// Run: node e2e/embedded/fork.test.mjs

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, launchBrowser, screenshot } from '../helpers/setup.mjs';

const PORT = 8150;
const BASE = `http://127.0.0.1:${PORT}`;
const TITLE = 'FORKPROBE-ui';

// ============================== fixtures =====================================

const SEED_MSGS = [
  { id: 'msg_fork_1', text: 'forkprobe message 1' },
  { id: 'msg_fork_2', text: 'forkprobe message 2' },
  { id: 'msg_fork_3', text: 'forkprobe message 3' },
];

// sessions keyed by id
const sessions = {};
// messages keyed by session id
const sessionMsgs = {};

function makeSid() {
  return `ses_fork_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

function buildSession(title) {
  const id = makeSid();
  sessions[id] = { id, title, revert: null };
  sessionMsgs[id] = [];
  return sessions[id];
}

function addMessage(sid, text) {
  const id = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const msg = {
    id,
    role: 'user',
    parts: [{ id: `part_${id}`, type: 'text', text }],
    time: { created: Date.now() },
  };
  sessionMsgs[sid].push(msg);
  return msg;
}

// ============================== fake engine ==================================

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

const state = {
  forkedSessions: [], // {newSid, srcSid, messageID, messages}
};

const server = http.createServer(async (req, res) => {
  const p = (req.path_url ??= req.url.split('?')[0]);

  try {
    // ---- test introspection -------------------------------------------------
    if (p === '/__state') {
      return json(res, { sessions: Object.keys(sessions), forked: state.forkedSessions });
    }

    // ---- history (chatserver stubs) ------------------------------------------
    if (p === '/api/history/sessions') {
      return json(res, Object.values(sessions).map((s) => ({
        id: s.id,
        title: s.title,
        created: Date.now() - 120_000,
        updated: Date.now() - 30_000,
        message_count: (sessionMsgs[s.id] ?? []).length,
        cost: 0,
      })));
    }
    if (p.endsWith('/errors')) {
      if (req.method === 'GET') return json(res, []);
      return json(res, { ok: true });
    }
    if (p.startsWith('/api/history/session/')) {
      const sid = p.split('/api/history/session/')[1]?.split('/')[0];
      return json(res, sessionMsgs[sid] ?? []);
    }

    // ---- engine stubs -------------------------------------------------------
    if (p === '/oc/session/status') return json(res, {});

    // GET /oc/session/{id}/message — return messages for that session
    const mMsg = p.match(/^\/oc\/session\/([^/]+)\/message$/);
    if (mMsg && req.method === 'GET') {
      return json(res, sessionMsgs[mMsg[1]] ?? []);
    }

    // POST /oc/session/{id}/fork — fork a session
    const mFork = p.match(/^\/oc\/session\/([^/]+)\/fork$/);
    if (mFork && req.method === 'POST') {
      const srcSid = mFork[1];
      const body = JSON.parse((await readBody(req)) || '{}');
      const srcMsgs = sessionMsgs[srcSid] ?? [];

      // Find the message index; messages BEFORE that index are copied (exclusive)
      const mid = body.messageID;
      let forkIdx = srcMsgs.length; // default: copy all
      if (mid) {
        const idx = srcMsgs.findIndex((m) => m.id === mid);
        if (idx >= 0) forkIdx = idx;
      }

      const copied = srcMsgs.slice(0, forkIdx);
      const srcTitle = sessions[srcSid]?.title ?? 'source';

      // Create new session with subset of messages
      const newSession = buildSession(`${srcTitle} (fork #1)`);
      sessionMsgs[newSession.id] = copied.map((m) => ({
        ...m,
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      }));

      state.forkedSessions.push({ newSid: newSession.id, srcSid, messageID: mid, count: copied.length });
      return json(res, newSession);
    }

    // POST /oc/session — create a session
    if (p === '/oc/session' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const s = buildSession(body.title ?? 'New session');
      return json(res, s);
    }

    // POST /oc/session/{id}/message — create a message (noReply seed path)
    const mCreateMsg = p.match(/^\/oc\/session\/([^/]+)\/message$/);
    if (mCreateMsg && req.method === 'POST') {
      const sid = mCreateMsg[1];
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!sessionMsgs[sid]) sessionMsgs[sid] = [];
      const text = body.parts?.[0]?.text ?? '';
      const msg = addMessage(sid, text);
      return json(res, { info: msg, parts: msg.parts });
    }

    // DELETE /oc/session/{id}
    const mDel = p.match(/^\/oc\/session\/([^/]+)$/);
    if (mDel && req.method === 'DELETE') {
      delete sessions[mDel[1]];
      delete sessionMsgs[mDel[1]];
      return json(res, {});
    }

    if (p === '/oc/config/providers')
      return json(res, {
        providers: [{ id: 'opencode', models: {} }],
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
      /* headers already sent */
    }
  }
});

// ================================ run =======================================

const results = [];
let pageErrors = [];

function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail });
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log(`fake engine on :${PORT}`);

  // ---- seed the probe session with 3 user messages -------------------------
  const sess = buildSession(TITLE);
  const mids = [];
  for (let i = 1; i <= 3; i++) {
    const msg = addMessage(sess.id, `forkprobe message ${i}`);
    mids.push(msg.id);
  }
  console.log('seeded', sess.id, mids.length, 'messages');

  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => pageErrors.push(e.message));

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForSelector('.sidebar .item', { timeout: 10000 });
    await page.waitForTimeout(1200);

    // ---- open the probe session from the sidebar
    await page.click(`.sidebar .item[title="${TITLE}"]`);
    await page.waitForTimeout(1500);
    const rows = await page.locator('.tabpane:visible .msg.user').count();
    console.log('[1] user rows in opened tab:', rows);

    // ---- hover the SECOND user message and click its fork button
    const second = page.locator('.tabpane:visible .msg.user').nth(1);
    await second.hover();
    const forkBtn = second.locator('button[title^="Fork a new session"]');
    check('fork button visible on hover', await forkBtn.isVisible());
    const btns = await second.locator('.acts button').count();
    console.log('[2] acts buttons on user row:', btns, '(expect 3: revert/fork/delete)');
    await forkBtn.click();

    // ---- new tab must activate, be titled by the engine, show 1 user msg
    await page.waitForTimeout(2000);
    const activeTitle = await page.locator('.tabsbar .tab.active, .tab.active').first().innerText().catch(() => '?');
    const forkRows = await page.locator('.tabpane:visible .msg.user').count();
    const inputVal = await page.inputValue('#composer-input:visible');
    console.log('[3] after fork click:');
    console.log('    active tab title:', JSON.stringify(activeTitle.trim()));
    console.log('    user rows in new tab:', forkRows, '(expect 1 — exclusive semantics)');
    console.log('    composer prefilled:', JSON.stringify(inputVal));

    check('exactly 1 user message in fork tab', forkRows === 1, `got ${forkRows}`);
    check('composer prefilled with forked-from text', inputVal === 'forkprobe message 2');
    check('active tab title contains "fork"', /fork/i.test(activeTitle.trim()), activeTitle.trim());

    // ---- original tab untouched?
    const origTab = page.locator(`.tabbar .tab[title="${TITLE}"]`).first();
    await origTab.click();
    await page.waitForTimeout(800);
    const origRows = await page.locator('.tabpane:visible .msg.user').count();
    console.log('[4] original tab still has:', origRows, 'user rows (expect 3)');
    check('source session still has 3 messages', origRows === 3, `got ${origRows}`);

    await screenshot(page, 'fork-verify');
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
console.log('Checks:', results.length, '| failed:', fails);
if (pageErrors.length) {
  console.log(`\npage errors observed (${pageErrors.length}):`);
  for (const e of [...new Set(pageErrors)].slice(0, 5)) console.log('  •', e.slice(0, 220));
}
process.exitCode = fails ? 1 : 0;
