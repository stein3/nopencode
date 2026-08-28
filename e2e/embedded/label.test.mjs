// verify-label.mjs — Model picker label updates correctly after empty-state
// dropdown pick and topbar menu pick.
//
// Self-contained fake engine: serves webui/dist + stub /oc endpoints + SSE,
// driven via /__ctl + introspected via /__state.  No live engine/chatserver.
//
// Checks:
//   L1 collapsed label shows fallback text on fresh session
//   L2 picking big-pickle via empty-state dropdown updates the label
//   L3 open+close topbar menu does not reset the label
//   L4 picking Big Pickle via topbar menu updates the label
//
// Run: node e2e/embedded/label.test.mjs

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, launchBrowser, createChecker, screenshot, SHOTS_DIR } from '../helpers/setup.mjs';

const PORT = 8142;
const BASE = `http://127.0.0.1:${PORT}`;
const SID = 'ses_label01';

// ============================== fixtures ====================================

const MODELS = {
  'big-pickle': { id: 'big-pickle', name: 'Big Pickle' },
  'x-preview-f-free': { id: 'x-preview-f-free' },
  'ox-alpha-free': { id: 'ox-alpha-free' },
};

const MESSAGES = []; // empty session → empty-state ModelSelect shown

// ============================== fake server =================================

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain',
};

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => resolve(d));
  });
}

const json = (res, obj, code = 200) => {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length });
  res.end(b);
};

const sseClients = new Set();
function sseEmit(type, properties = {}) {
  const frame = `data: ${JSON.stringify({ type, properties })}\n\n`;
  for (const res of sseClients) try { res.write(frame); } catch {}
}

const state = { counts: {} };

const server = http.createServer(async (req, res) => {
  const p = (req.path_url ??= req.url.split('?')[0]);
  state.counts[p] = (state.counts[p] ?? 0) + 1;
  try {
    // ---- test introspection + control -------------------------------------
    if (p === '/__state') return json(res, { counts: state.counts });
    if (p === '/__ctl') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (body.emit) sseEmit(body.emit.type, body.emit.properties ?? {});
      return json(res, { ok: true });
    }

    // ---- SSE ----------------------------------------------------------------
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

    // ---- engine stubs -------------------------------------------------------
    if (p === '/oc/session/status') return json(res, {});
    if (p.startsWith('/oc/session/') && p.endsWith('/message'))
      return json(res, MESSAGES);
    if (p.startsWith('/oc/session/'))
      return json(res, { id: SID, title: 'label-test', revert: null });
    if (p === '/oc/session' && req.method === 'POST')
      return json(res, { id: SID, title: 'label-test', revert: null });
    if (p === '/oc/config/providers')
      return json(res, {
        providers: [{ id: 'opencode', models: MODELS }],
      });
    if (p === '/oc/path') return json(res, { directory: '/workspace' });
    if (p === '/oc/mcp') return json(res, {});
    if (p === '/oc/permission' || p === '/oc/question') return json(res, []);
    if (p.startsWith('/oc/')) return json(res, []);

    // ---- history (chatserver stubs) -----------------------------------------
    if (p === '/api/history/sessions')
      return json(res, [
        { id: SID, title: 'label-test', created: Date.now() - 120_000, updated: Date.now() - 30_000, message_count: 0, cost: 0 },
      ]);
    if (p.startsWith('/api/history/session/')) return json(res, []);

    // ---- statics (webui/dist) -----------------------------------------------
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
    try { json(res, { error: String(e) }, 500); } catch {}
  }
});

// ================================ checks ====================================

const { check, summary } = createChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ================================ run =======================================

try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

  try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(2500);

    // start a new chat so the empty state shows
    await page.keyboard.press('Control+t');
    const emptySelect = page.locator('.tabpane[style*="flex"] .empty select');
    await emptySelect.waitFor({ timeout: 10000 });

    // L1: collapsed label should show some fallback text (not "Model for next message" — it will be the default model or "model…")
    const btn = page.locator('.tabpane[style*="flex"] button[title="Model for next message"]');
    const labelBefore = (await btn.textContent()).trim();
    console.log('  collapsed label on fresh session:', JSON.stringify(labelBefore));
    check('L1', 'button exists and has text', labelBefore.length > 0, labelBefore);

    // L2: pick big-pickle via the empty-state dropdown
    await page.selectOption('.tabpane[style*="flex"] .empty select', 'opencode/big-pickle');
    await sleep(600);
    const labelAfterPick = (await btn.textContent()).trim();
    console.log('  collapsed label after empty-state pick:', JSON.stringify(labelAfterPick));
    check(
      'L2',
      'label shows picked model name after empty-state dropdown pick',
      /big.?pickle/i.test(labelAfterPick),
      labelAfterPick,
    );

    // L3: open + close the topbar menu without picking — label must stay
    await btn.click();
    await page.locator('.tabpane[style*="flex"] .menu').waitFor({ timeout: 3000 });
    await page.keyboard.press('Escape');
    await sleep(200);
    // toggle closed again if still open
    const menuVisible = await page.locator('.tabpane[style*="flex"] .menu').isVisible().catch(() => false);
    if (menuVisible) await btn.click();
    await sleep(300);
    const labelAfterToggle = (await btn.textContent()).trim();
    console.log('  collapsed label after menu toggle:', JSON.stringify(labelAfterToggle));
    check(
      'L3',
      'label unchanged after menu open+close',
      /big.?pickle/i.test(labelAfterToggle),
      labelAfterToggle,
    );

    // L4: pick Big Pickle via the topbar menu
    await btn.click();
    await page.locator('.tabpane[style*="flex"] .menu').waitFor({ timeout: 3000 });
    await page.click('.tabpane[style*="flex"] .menu button.m:has-text("Big Pickle")');
    await sleep(400);
    const labelAfterMenuPick = (await btn.textContent()).trim();
    console.log('  collapsed label after topbar pick:', JSON.stringify(labelAfterMenuPick));
    check(
      'L4',
      'label shows Big Pickle after topbar menu pick',
      /big.?pickle/i.test(labelAfterMenuPick),
      labelAfterMenuPick,
    );

    await screenshot(page, 'label-embedded');
  } finally {
    await browser.close();
  }
} finally {
  await new Promise((r) => server.close(r));
}

// =============================== summary ====================================

console.log('\n================ SUMMARY ================');
process.exit(summary());
