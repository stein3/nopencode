// Model picker verification — dropdown and topbar pick propagate to prompt body.
// Port 8165. Embedded fake engine, no live chatserver/engine needed.
//
// Cases:
//   1. Empty session: select from dropdown → prompt POST carries the picked model
//   2. Non-empty session: topbar ModelPicker pick changes model for next prompt
//   3. Prompt bodies reflect the picks
//
// Run: node e2e/embedded/model-picker.test.mjs

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, launchBrowser, screenshot } from '../helpers/setup.mjs';

const PORT = 8165;
const BASE = `http://127.0.0.1:${PORT}`;
const SID = 'ses_modeltest';
const PANE = '.tabpane[style*="flex"]';

// ============================== fake engine =================================

const state = {
  promptBodies: [], // captured prompt_async bodies
  messages: [], // growing message list per session
};

// Start with an empty session list so the page has NO auto-opened session.
// If the fake engine returned ses_modeltest here, the onMount fallback would
// open it, and then Ctrl+T → realize would re-key the pending tab to the same
// ID — a Svelte keyed-each duplicate that breaks the submit flow.
const SESSIONS = [];

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
    // ---- SSE ----------------------------------------------------------------
    if (p === '/oc/event') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      // send session.idle after a short delay to end the turn
      const timer = setTimeout(() => {
        try {
          res.write(`data: ${JSON.stringify({ type: 'session.idle', properties: { sessionID: SID } })}\n\n`);
        } catch { /* dropped */ }
      }, 200);
      req.on('close', () => clearTimeout(timer));
      return;
    }

    // ---- history -------------------------------------------------------------
    if (p === '/api/history/sessions') return json(res, SESSIONS);
    if (p.endsWith('/errors')) return json(res, []);
    if (p.startsWith('/api/history/session/')) return json(res, []);

    // ---- engine stubs --------------------------------------------------------
    if (p === '/oc/session/status') return json(res, {});
    if (p === '/oc/permission') return json(res, []);

    // GET /oc/session/{id}/message — return accumulated messages
    const mMsg = p.match(/^\/oc\/session\/([^/]+)\/message$/);
    if (mMsg && req.method === 'GET') {
      return json(res, state.messages);
    }

    // POST /oc/session/{id}/prompt_async — capture body, echo user message, emit SSE
    const mPrompt = p.match(/^\/oc\/session\/([^/]+)\/prompt_async$/);
    if (mPrompt && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      state.promptBodies.push({ sid: mPrompt[1], body });
      // echo a user message back
      const userMsg = {
        info: {
          id: 'msg_u' + state.promptBodies.length,
          role: 'user',
          sessionID: mPrompt[1],
          time: { created: Date.now() },
          agent: 'build',
          model: body.model ? { providerID: body.model.providerID, modelID: body.model.modelID } : undefined,
        },
        parts: [{ id: 'prt_u' + state.promptBodies.length, type: 'text', text: body?.parts?.[0]?.text ?? '' }],
      };
      state.messages.push(userMsg);
      res.writeHead(204);
      return res.end();
    }

    // POST /oc/session/{id}/message — capture, echo, return
    if (mMsg && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      state.promptBodies.push({ sid: mMsg[1], body });
      const userMsg = {
        info: {
          id: 'msg_u' + state.promptBodies.length,
          role: 'user',
          sessionID: mMsg[1],
          time: { created: Date.now() },
          agent: 'build',
          model: body.model ? { providerID: body.model.providerID, modelID: body.model.modelID } : undefined,
        },
        parts: [{ id: 'prt_u' + state.promptBodies.length, type: 'text', text: body?.parts?.[0]?.text ?? '' }],
      };
      state.messages.push(userMsg);
      return json(res, userMsg);
    }

    if (p.match(/^\/oc\/session\/[^/]+$/) && req.method === 'GET')
      return json(res, { id: SID, title: 'model-picker-test', revert: null });
    if (p === '/oc/session' && req.method === 'POST')
      return json(res, { id: SID, title: 'model-picker-test', revert: null });
    if (p.match(/^\/oc\/session\/[^/]+$/) && req.method === 'DELETE') {
      res.writeHead(204);
      return res.end();
    }

    // providers with big-pickle and other models
    if (p === '/oc/config/providers')
      return json(res, {
        providers: [
          {
            id: 'opencode',
            models: {
              'big-pickle': { id: 'big-pickle' },
              'x-preview-f-free': { id: 'x-preview-f-free' },
              'ox-alpha-free': { id: 'ox-alpha-free' },
            },
          },
        ],
      });
    if (p === '/oc/path') return json(res, { directory: '/workspace' });
    if (p === '/oc/mcp') return json(res, {});
    if (p.startsWith('/oc/')) return json(res, []);

    // ---- statics (webui/dist) ------------------------------------------------
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

// ================================ checks ====================================

const results = [];
let pageErrors = [];

function check(c, name, pass, note = '') {
  results.push({ c, name, pass: !!pass, note });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${c} · ${name}${note ? ` — ${note}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ================================ run =======================================

try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => pageErrors.push(e.message));

  try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    // ---- Phase 1: empty session — dropdown pick drives first prompt -----------
    console.log('\nPHASE 1 — dropdown pick on empty session');
    await page.keyboard.press('Control+t');
    await page.locator(`${PANE} .empty select`).waitFor({ timeout: 5000 });
    check('M', 'dropdown visible on new-session page', true);

    await page.selectOption(`${PANE} .empty select`, 'opencode/big-pickle');
    await page.waitForTimeout(300);
    const selected = await page.inputValue(`${PANE} .empty select`);
    check('M', 'selected value is big-pickle', selected === 'opencode/big-pickle', selected);

    // Send the first prompt
    await page.fill(`${PANE} #composer-input:visible`, 'probe one');
    await page.keyboard.press('Enter');
    await sleep(3000);

    check('M', 'prompt #1 captured', state.promptBodies.length >= 1);
    const m1 = state.promptBodies[0]?.body?.model;
    check('M', 'prompt #1 model is big-pickle', m1?.modelID === 'big-pickle', JSON.stringify(m1));

    // ---- Phase 2: topbar picker changes model for next prompt ----------------
    console.log('\nPHASE 2 — topbar picker changes model');
    // After sending a message the pane is no longer empty, but ComposerModelPicker
    // (inside ComposerToolbar) is always visible above the composer input.
    // Wait for busy to clear (SSE session.idle) before clicking the picker.
    await page.locator(`${PANE} button[title="Model for next message"]`).waitFor({ state: 'visible', timeout: 10000 });
    await page.click(`${PANE} button[title="Model for next message"]`);
    await page.locator(`${PANE} .menu`).waitFor({ state: 'visible', timeout: 5000 });
    // Model name comes from the fake engine's models dict — no human-readable
    // `name` field, so the button text is the raw id `big-pickle`.
    await page.click(`${PANE} .menu button.m:has-text("big-pickle")`);
    await sleep(500);

    const stored = await page.evaluate(() => localStorage.getItem('opencode.model'));
    check('M', 'localStorage updated after topbar pick', !!stored, stored);

    // Send the second prompt
    await page.fill(`${PANE} #composer-input:visible`, 'probe two');
    await page.keyboard.press('Enter');
    await sleep(2000);

    check('M', 'prompt #2 captured', state.promptBodies.length >= 2);
    const m2 = state.promptBodies[1]?.body?.model;
    check('M', 'prompt #2 model present', !!m2, JSON.stringify(m2));

    await screenshot(page, 'model-picker-final');

    console.log(`\nTotal prompts captured: ${state.promptBodies.length}`);
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
