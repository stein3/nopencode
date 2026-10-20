// Cross-client session model sync — the engine's session.model wins when this
// device has no explicit pick of its own. Port 8173. Embedded fake engine.
//
// Scenario mirrored: pick a model on the desktop (engine stores it), open the
// same session on another device (empty localStorage) — the next message must
// use the engine's model, and the picker must show it.
//
// Cases:
//   S1 open with no local pick     → picker label = engine session model
//   S2 same                       → prompt body carries the engine model
//   S3 engine model changes + reload (other device sent) → label + prompt follow
//   S4 explicit local pick        → beats the engine value (immediately)
//   S5 local pick survives a reload even when the engine says otherwise
//
// Run: cd ../webui && WEBUI_BASE=/ npm run build && node e2e/embedded/model-sync.test.mjs

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, launchBrowser, screenshot, sleep } from '../helpers/setup.mjs';

const PORT = 8173;
const BASE = `http://127.0.0.1:${PORT}`;
const SID = 'ses_modelsync01';
const PANE = '.tabpane[style*="flex"]';
const ENGINE_MODEL_A = 'ox-alpha-free';
const ENGINE_MODEL_B = 'x-preview-f-free';
const LOCAL_PICK = 'big-pickle';

// ============================== fake engine =================================

const state = {
  promptBodies: [],
  messages: [],
  // what GET /oc/session/{id} reports — mutated mid-test to simulate a model
  // change made by ANOTHER client (its prompt landed server-side)
  sessionModel: { providerID: 'opencode', id: ENGINE_MODEL_A, variant: 'default' },
};

const SESSIONS = [
  {
    id: SID,
    title: 'model-sync probe',
    created: Date.now() - 600_000,
    updated: Date.now() - 60_000,
    message_count: 0,
    cost: 0,
    model: ENGINE_MODEL_A,
    model_provider: 'opencode',
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
    if (p === '/oc/event') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      const timer = setTimeout(() => {
        try {
          res.write(`data: ${JSON.stringify({ type: 'session.idle', properties: { sessionID: SID } })}\n\n`);
        } catch { /* dropped */ }
      }, 200);
      req.on('close', () => clearTimeout(timer));
      return;
    }

    if (p === '/api/history/sessions') return json(res, SESSIONS);
    if (p.endsWith('/errors')) return json(res, []);
    if (p.startsWith('/api/history/session/')) return json(res, []);

    if (p === '/oc/session/status') return json(res, {});
    if (p === '/oc/permission') return json(res, []);

    const mMsg = p.match(/^\/oc\/session\/([^/]+)\/message$/);
    if (mMsg && req.method === 'GET') return json(res, state.messages);

    const mPrompt = p.match(/^\/oc\/session\/([^/]+)\/prompt_async$/);
    if (mPrompt && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      state.promptBodies.push({ sid: mPrompt[1], body });
      // a real engine records the prompt's model on the session BEFORE the 204
      if (body.model) state.sessionModel = { providerID: body.model.providerID, id: body.model.modelID, variant: 'default' };
      state.messages.push({
        info: {
          id: 'msg_u' + state.promptBodies.length,
          role: 'user',
          sessionID: mPrompt[1],
          time: { created: Date.now() },
          model: body.model ? { providerID: body.model.providerID, modelID: body.model.modelID } : undefined,
        },
        parts: [{ id: 'prt_u' + state.promptBodies.length, type: 'text', text: body?.parts?.[0]?.text ?? '' }],
      });
      res.writeHead(204);
      return res.end();
    }

    // GET /oc/session/{id} — carries the session model every client reads
    if (p.match(/^\/oc\/session\/[^/]+$/) && req.method === 'GET')
      return json(res, { id: SID, title: 'model-sync probe', revert: null, cost: 0, model: state.sessionModel });
    if (p === '/oc/session' && req.method === 'POST')
      return json(res, { id: SID, title: 'model-sync probe', revert: null });

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

const modelBtnLabel = (page) => page.locator(`${PANE} button[title="Model for next message"] .lbl`).innerText();

async function send(page, text) {
  await page.fill(`${PANE} #composer-input:visible`, text);
  await page.keyboard.press('Enter');
  await sleep(1200);
}

// ================================ run =======================================

try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => pageErrors.push(e.message));

  try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.locator(`${PANE} button[title="Model for next message"]`).waitFor({ timeout: 15000 });

    // ---- S1/S2: no local pick → engine's session model is used -------------
    console.log('\nPHASE 1 — fresh device, engine model adopted');
    const lbl1 = (await modelBtnLabel(page)).trim();
    check('S1', `picker shows engine model (${ENGINE_MODEL_A})`, lbl1 === ENGINE_MODEL_A, lbl1);

    const localPick1 = await page.evaluate(() => localStorage.getItem('opencode.sessionModels'));
    check('S1', 'no local session pick was written by hydration', !localPick1?.includes(SID), localPick1 ?? 'null');

    await send(page, 'probe one');
    check('S2', 'prompt captured', state.promptBodies.length >= 1);
    check(
      'S2',
      `prompt #1 uses engine model (${ENGINE_MODEL_A})`,
      state.promptBodies[0]?.body?.model?.modelID === ENGINE_MODEL_A,
      JSON.stringify(state.promptBodies[0]?.body?.model),
    );

    // ---- S3: another client switched the model; a new visit must follow ----
    console.log('\nPHASE 2 — model changed by another client, then reload');
    state.sessionModel = { providerID: 'opencode', id: ENGINE_MODEL_B, variant: 'default' };
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator(`${PANE} button[title="Model for next message"]`).waitFor({ timeout: 15000 });
    const lbl2 = (await modelBtnLabel(page)).trim();
    check('S3', `reload picks up the other client's model (${ENGINE_MODEL_B})`, lbl2 === ENGINE_MODEL_B, lbl2);

    await send(page, 'probe two');
    check(
      'S3',
      `prompt #2 follows the other client (${ENGINE_MODEL_B})`,
      state.promptBodies[1]?.body?.model?.modelID === ENGINE_MODEL_B,
      JSON.stringify(state.promptBodies[1]?.body?.model),
    );

    // ---- S4/S5: an explicit local pick beats the engine value --------------
    console.log('\nPHASE 3 — explicit local pick wins');
    await page.locator(`${PANE} button[title="Model for next message"]`).waitFor({ state: 'visible', timeout: 10000 });
    await page.click(`${PANE} button[title="Model for next message"]`);
    await page.locator(`${PANE} .menu`).waitFor({ state: 'visible', timeout: 5000 });
    await page.click(`${PANE} .menu button.m:has-text("${LOCAL_PICK}")`);
    await sleep(400);
    const lbl3 = (await modelBtnLabel(page)).trim();
    check('S4', `local pick shown (${LOCAL_PICK})`, lbl3 === LOCAL_PICK, lbl3);

    await send(page, 'probe three');
    check(
      'S4',
      `prompt #3 uses the local pick (${LOCAL_PICK})`,
      state.promptBodies[2]?.body?.model?.modelID === LOCAL_PICK,
      JSON.stringify(state.promptBodies[2]?.body?.model),
    );

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator(`${PANE} button[title="Model for next message"]`).waitFor({ timeout: 15000 });
    const lbl4 = (await modelBtnLabel(page)).trim();
    check('S5', `local pick survives reload (engine still says ${ENGINE_MODEL_B})`, lbl4 === LOCAL_PICK, lbl4);

    await screenshot(page, 'model-sync-final');
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
