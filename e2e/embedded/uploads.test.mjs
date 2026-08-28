// Verify composer file uploads end-to-end (embedded fake engine, no live engine).
// Port 8164.
//
// Cases:
//   1. attach button path: setInputFiles(png + .ts) -> tray chips (thumb + ext badge)
//   2. drag & drop: synthetic File drop on the pane -> dropping affordance + chip
//   3. oversize guard: 11MB file -> inline "larger than" error
//   4. transcript rendering: seeded file parts -> image opens lightbox, code file renders chip
//
// The fake engine returns canned responses for /oc/session/{id}/message and
// prompt_async so no real engine is needed.
//
// Run: node e2e/embedded/uploads.test.mjs

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, launchBrowser, screenshot } from '../helpers/setup.mjs';

const PORT = 8164;
const BASE = `http://127.0.0.1:${PORT}`;
const SID = 'ses_uploads';

// ============================== fake engine =================================

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const SESSIONS = [
  {
    id: SID,
    title: 'uploads-render-fixture',
    created: Date.now() - 120_000,
    updated: Date.now() - 30_000,
    message_count: 1,
    cost: 0,
  },
];

const MESSAGES = [
  {
    info: {
      id: 'msg_seed1',
      role: 'user',
      sessionID: SID,
      time: { created: Date.now() - 60_000 },
    },
    parts: [
      { id: 'part_file1', type: 'file', mime: 'image/png', url: `data:image/png;base64,${PNG_B64}`, filename: 'diagram.png' },
      { id: 'part_file2', type: 'file', mime: 'text/typescript', url: 'data:text/typescript;base64,ZXhwb3J0IGNvbnN0IGFuc3dlciA9IDQyCg==', filename: 'answer.ts' },
    ],
  },
];

const state = { promptBodies: [] };

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
      req.on('close', () => {});
      return;
    }

    // ---- history -------------------------------------------------------------
    if (p === '/api/history/sessions') return json(res, SESSIONS);
    if (p.endsWith('/errors')) return json(res, []);
    if (p.startsWith('/api/history/session/')) return json(res, []);

    // ---- engine stubs --------------------------------------------------------
    if (p === '/oc/session/status') return json(res, {});
    if (p === '/oc/permission') return json(res, []);

    const mMsg = p.match(/^\/oc\/session\/([^/]+)\/message$/);
    if (mMsg && req.method === 'GET') {
      if (mMsg[1] === SID) return json(res, MESSAGES);
      return json(res, []);
    }

    // POST /oc/session/{id}/message — accept and return success
    if (mMsg && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      state.promptBodies.push({ sid: mMsg[1], body });
      return json(res, {
        info: {
          id: 'msg_probe' + state.promptBodies.length,
          role: 'user',
          sessionID: mMsg[1],
          time: { created: Date.now() },
        },
        parts: [{ id: 'prt_probe' + state.promptBodies.length, type: 'text', text: body?.parts?.[0]?.text ?? '' }],
      });
    }

    // POST /oc/session/{id}/prompt_async — accept, return 204
    const mPrompt = p.match(/^\/oc\/session\/([^/]+)\/prompt_async$/);
    if (mPrompt && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      state.promptBodies.push({ sid: mPrompt[1], body });
      res.writeHead(204);
      return res.end();
    }

    // POST /oc/session/{id}/abort — return 204
    const mAbort = p.match(/^\/oc\/session\/([^/]+)\/abort$/);
    if (mAbort && req.method === 'POST') {
      res.writeHead(204);
      return res.end();
    }

    if (p.match(/^\/oc\/session\/[^/]+$/) && req.method === 'GET')
      return json(res, { id: SID, title: 'uploads-render-fixture', revert: null });
    if (p === '/oc/session' && req.method === 'POST')
      return json(res, { id: SID, title: 'uploads-render-fixture', revert: null });
    if (p.match(/^\/oc\/session\/[^/]+$/) && req.method === 'DELETE') {
      res.writeHead(204);
      return res.end();
    }

    if (p === '/oc/config/providers')
      return json(res, { providers: [{ id: 'opencode', models: {} }] });
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

const TMP = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'tmp-uploads');
fs.mkdirSync(TMP, { recursive: true });
// write real file fixtures for setInputFiles
fs.writeFileSync(path.join(TMP, 'shot.png'), Buffer.from(PNG_B64, 'base64'));
fs.writeFileSync(path.join(TMP, 'app.ts'), 'export const answer = 42\n');
const HUGE = { name: 'huge.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(11 * 1024 * 1024, 7) };

try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const browser = await launchBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));

  const PANE = '.tabpane[style*="flex"]';
  const chips = () => page.locator(`${PANE} .tray .chip`);
  const composer = () => page.locator(`${PANE} .composer`);

  try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);

    // open a fresh chat
    if (!(await page.locator('.sidebar').isVisible().catch(() => false))) {
      await page.locator('button.burger').click();
      await page.waitForTimeout(300);
    }
    await page.locator('.sidebar .new').click();
    await page.waitForTimeout(600);
    check('U', 'tray starts empty', (await chips().count()) === 0);

    // ---- 1. attach-button path -----------------------------------------------
    console.log('\nCASE 1 — attach-button picks files');
    await page.setInputFiles(`${PANE} input[type="file"]`, [path.join(TMP, 'shot.png'), path.join(TMP, 'app.ts')]);
    await page.waitForTimeout(300);
    check('U', 'two chips staged via picker', (await chips().count()) === 2);
    check('U', 'image chip shows thumbnail', (await page.locator(`${PANE} .chip .cthumb`).count()) === 1);
    const ext = (await page.locator(`${PANE} .chip .cext`).first().textContent()) ?? '';
    check('U', `code chip badge is TS (got "${ext.trim()}")`, ext.trim() === 'TS');
    await screenshot(page, 'uploads-tray');

    // ---- 2. drag & drop ------------------------------------------------------
    console.log('\nCASE 2 — drag & drop');
    await page.evaluate(() => {
      const pane = document.querySelector('.tabpane[style*="flex"]');
      const dt = new DataTransfer();
      dt.items.add(new File(['dropped-content'], 'dropped.py', { type: 'text/x-python' }));
      for (const type of ['dragenter', 'dragover']) {
        pane.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      }
    });
    await page.waitForTimeout(200);
    check('U', 'drop hint visible while dragging', await page.locator(`${PANE} .drophint`).isVisible());
    check('U', 'composer gets .dropping affordance',
      ((await composer().getAttribute('class')) ?? '').includes('dropping'));
    await screenshot(page, 'uploads-dragover');

    await page.evaluate(() => {
      const pane = document.querySelector('.tabpane[style*="flex"]');
      const dt = new DataTransfer();
      dt.items.add(new File(['dropped-content'], 'dropped.py', { type: 'text/x-python' }));
      pane.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    await page.waitForTimeout(300);
    check('U', 'synthetic drop lands third chip (PY)', (await chips().count()) === 3);

    // clean drag state
    await page.evaluate(() => {
      const pane = document.querySelector('.tabpane[style*="flex"]');
      pane.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true, relatedTarget: null }));
    });

    // ---- 3. oversize guard ---------------------------------------------------
    console.log('\nCASE 3 — oversize guard');
    await page.setInputFiles(`${PANE} input[type="file"]`, [HUGE]);
    await page.waitForTimeout(300);
    const errText = (await page.locator(`${PANE} .composer .error`).first().textContent()) ?? '';
    check('U', `oversize error shown (got "${errText.trim()}")`, errText.includes('larger than'));
    await screenshot(page, 'uploads-oversize');

    // remove one chip
    await page.locator(`${PANE} .chip .crm`).first().click();
    await page.waitForTimeout(150);
    check('U', 'remove button deletes a chip', (await chips().count()) === 2);

    // ---- 4. transcript rendering of stored file parts -----------------------
    console.log('\nCASE 4 — transcript rendering');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await page.locator(`.sidebar .item:has-text("uploads-render-fixture")`).first().click();
    await page.waitForTimeout(1200);
    const img = page.locator(`${PANE} .msgimg img`);
    check('U', 'stored image part renders as message thumbnail', (await img.count()) === 1);
    const fname = (await page.locator(`${PANE} .msgfile .fname`).first().textContent()) ?? '';
    check('U', `stored code part renders as filename chip (got "${fname}")`, fname.includes('answer.ts'));

    await img.click();
    await page.waitForTimeout(400);
    check('U', 'lightbox opens from message thumb',
      await page.locator('.lightbox img, .lb img, img[src^="data:image"]').last().isVisible().catch(() => false));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await screenshot(page, 'uploads-transcript');
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
