// palette-sid.test.mjs — verifies the ctrl+p palette resolves the ACTIVE
// session id at command-run time (regression for the frozen sessionId prop).
// Runs against an EMBEDDED fake engine (same pattern as question-picker.mjs).
//
// Cases:
//   A. open session A → /rename → PATCH /oc/session/<A>
//      open session B → /rename → PATCH /oc/session/<B>  (freshness)
//   B. pending tab (ctrl+t) → /rename → "no session yet" toast, no PATCH
//   C. themed rename dialog screenshot
//
// Run: node e2e/embedded/palette-sid.test.mjs

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, launchBrowser, screenshot, SHOTS_DIR, sleep } from '../helpers/setup.mjs';

const PORT = 8156;
const BASE = `http://127.0.0.1:${PORT}`;

const SID_A = 'ses_palette_a';
const SID_B = 'ses_palette_b';
const TITLE_A = 'palette-alpha';
const TITLE_B = 'palette-beta';

// ============================== fake engine =================================

const state = {
  patches: [],          // captured {sid, title} from PATCH requests
  counts: {},           // request path -> hit count
};
const sseClients = new Set();

function sseEmit(type, properties = {}) {
  const frame = `data: ${JSON.stringify({ type, properties })}\n\n`;
  for (const res of sseClients) {
    try { res.write(frame); } catch { /* dropped */ }
  }
}

const SESSIONS = [
  { id: SID_A, title: TITLE_A, created: Date.now() - 300_000, updated: Date.now() - 20_000, message_count: 2, cost: 0 },
  { id: SID_B, title: TITLE_B, created: Date.now() - 200_000, updated: Date.now() - 10_000, message_count: 3, cost: 0 },
];

const MESSAGES_A = [
  {
    info: { id: 'msg_a1', role: 'user', time: { created: Date.now() - 60_000 } },
    parts: [{ id: 'part_a1', type: 'text', text: 'hello from A' }],
  },
  {
    info: { id: 'msg_a2', role: 'assistant', agent: 'build', modelID: 'x-preview-f-free', providerID: 'opencode', time: { created: Date.now() - 55_000 } },
    parts: [{ id: 'part_a2', type: 'text', text: 'response A' }],
  },
];

const MESSAGES_B = [
  {
    info: { id: 'msg_b1', role: 'user', time: { created: Date.now() - 50_000 } },
    parts: [{ id: 'part_b1', type: 'text', text: 'hello from B' }],
  },
  {
    info: { id: 'msg_b2', role: 'assistant', agent: 'build', modelID: 'x-preview-f-free', providerID: 'opencode', time: { created: Date.now() - 45_000 } },
    parts: [{ id: 'part_b2', type: 'text', text: 'response B1' }],
  },
  {
    info: { id: 'msg_b3', role: 'assistant', agent: 'build', modelID: 'x-preview-f-free', providerID: 'opencode', time: { created: Date.now() - 40_000 } },
    parts: [{ id: 'part_b3', type: 'text', text: 'response B2' }],
  },
];

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
      return json(res, { patches: state.patches, counts: state.counts });
    }
    if (p === '/__ctl') {
      const ctl = JSON.parse((await readBody(req)) || '{}');
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

    // ---- history (chatserver stubs) ------------------------------------------
    if (p === '/api/history/sessions') return json(res, SESSIONS);
    if (p.endsWith('/errors')) {
      if (req.method === 'GET') return json(res, []);
      return json(res, { ok: true });
    }
    if (p.startsWith('/api/history/session/')) {
      const sid = p.split('/api/history/session/')[1]?.split('/')[0];
      if (sid === SID_A) return json(res, MESSAGES_A);
      if (sid === SID_B) return json(res, MESSAGES_B);
      return json(res, []);
    }

    // ---- engine stubs --------------------------------------------------------
    if (p === '/oc/session/status') return json(res, {});
    if (p.startsWith('/oc/session/') && p.endsWith('/message')) {
      const sid = p.split('/oc/session/')[1]?.split('/')[0];
      if (sid === SID_A) return json(res, MESSAGES_A);
      if (sid === SID_B) return json(res, MESSAGES_B);
      return json(res, []);
    }
    // PATCH /oc/session/{id} — capture rename requests
    if (req.method === 'PATCH' && p.match(/^\/oc\/session\/[^/]+$/)) {
      const sid = decodeURIComponent(p.split('/oc/session/')[1]);
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch {}
      state.patches.push({ sid, title: body.title });
      return json(res, { id: sid, title: body.title || 'renamed-probe' });
    }
    if (p.startsWith('/oc/session/') && !p.includes('/message')) {
      const sid = p.split('/oc/session/')[1]?.split('/')[0];
      const sess = SESSIONS.find((s) => s.id === sid);
      return json(res, { id: sid, title: sess?.title ?? 'probe', revert: null });
    }
    if (p === '/oc/session' && req.method === 'POST')
      return json(res, { id: SID_A, title: TITLE_A, revert: null });
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

  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => {
    console.log('UNEXPECTED NATIVE DIALOG:', d.message());
    d.dismiss();
  });

  try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // ---- helpers -------------------------------------------------------------
    async function paletteRunRename() {
      await page.keyboard.press('Control+p');
      const input = page.locator('.panel input');
      await input.waitFor({ state: 'visible', timeout: 4000 });
      await input.fill('rename');
      await page.waitForFunction(() => {
        const rows = [...document.querySelectorAll('.palette-list .row, .list .row')];
        return rows.some((r) => r.textContent.toLowerCase().includes('rename'));
      }, null, { timeout: 4000 }).catch(() => {
        throw new Error('/rename row not found in palette');
      });
      await page.keyboard.press('Enter');
    }

    async function submitRenameDialog(title) {
      const renameInput = page.locator('#rename-input');
      await renameInput.waitFor({ state: 'visible', timeout: 4000 });
      const pre = await renameInput.inputValue();
      if (!pre) throw new Error('rename dialog opened with empty prefill');
      console.log('ok – dialog prefilled with current title:', JSON.stringify(pre.slice(0, 40)));
      await renameInput.fill(title);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(600);
    }

    // Wait for sidebar rows to appear
    await page.waitForSelector('button.item .title', { timeout: 15000 });
    await sleep(500);

    // ---- A1: session A -------------------------------------------------------
    console.log('\nCASE A1 — open session A, /rename patches A');
    await page.locator('button.item', { hasText: TITLE_A }).first().click();
    await page.waitForTimeout(500);
    await paletteRunRename();
    await submitRenameDialog('palette-sid-probe');
    let st = await snap();
    check('A', 'PATCH went to session A',
      st.patches.length === 1 && st.patches[0].sid === SID_A,
      `sid=${st.patches[0]?.sid} expected=${SID_A}`);
    check('A', 'PATCH carried typed title',
      st.patches[0]?.title === 'palette-sid-probe',
      `title=${st.patches[0]?.title}`);
    // Tab bar should show engine-returned title
    await page.waitForFunction(
      () => [...document.querySelectorAll('.tabbar .label')].some((l) => l.textContent.includes('palette-sid-probe')),
      null, { timeout: 4000 },
    );
    check('A', 'tab bar shows engine-returned title "palette-sid-probe"', true);

    // ---- A2: switch to session B ---------------------------------------------
    console.log('\nCASE A2 — switch to session B, PATCH must target B');
    state.patches.length = 0;
    await page.locator('button.item', { hasText: TITLE_B }).first().click();
    await page.waitForTimeout(500);
    await paletteRunRename();
    await submitRenameDialog('palette-sid-probe');
    st = await snap();
    check('A', 'after tab switch PATCH went to session B',
      st.patches.length === 1 && st.patches[0].sid === SID_B,
      `sid=${st.patches[0]?.sid} expected=${SID_B}`);

    // ---- B: pending tab refuses politely -------------------------------------
    console.log('\nCASE B — pending tab → "no session yet" toast, no PATCH');
    state.patches.length = 0;
    await page.keyboard.press('Control+t');
    await page.waitForTimeout(300);
    await paletteRunRename();
    await page.waitForFunction(
      () => /no session yet/.test(document.querySelector('.toast')?.textContent ?? ''),
      null, { timeout: 4000 },
    );
    check('B', 'pending tab did not open the rename dialog',
      !(await page.locator('#rename-input').isVisible().catch(() => false)));
    st = await snap();
    check('B', 'pending tab produced no PATCH', st.patches.length === 0);

    // ---- C: themed dialog screenshot -----------------------------------------
    console.log('\nCASE C — themed rename dialog screenshot');
    state.patches.length = 0;
    await page.locator('button.item', { hasText: TITLE_A }).first().click();
    await page.waitForTimeout(500);
    await paletteRunRename();
    await page.locator('#rename-input').waitFor({ state: 'visible', timeout: 4000 });
    await screenshot(page, 'rename-dialog');
    check('C', 'screenshot saved', true);

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
