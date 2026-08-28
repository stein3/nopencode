// modelid.test.mjs — embedded fake-engine test for assistant model-id badge
//
// Verifies: assistant messages show a .model-id badge in the transcript;
// the badge text matches the provider/model from the engine response.
//
// Run: node e2e/embedded/modelid.test.mjs

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, launchBrowser, screenshot } from '../helpers/setup.mjs';

const PORT = 8151;
const BASE = `http://127.0.0.1:${PORT}`;
const SID = 'ses_modelid01';

// ============================== fixtures =====================================

const SESSIONS = [
  {
    id: SID,
    title: 'model-id-probe',
    created: Date.now() - 120_000,
    updated: Date.now() - 30_000,
    message_count: 3,
    cost: 0,
  },
];

const MESSAGES = [
  {
    info: {
      id: 'msg_mi_u1',
      role: 'user',
      time: { created: Date.now() - 60_000 },
    },
    parts: [{ id: 'part_u1', type: 'text', text: 'What is the capital of France?' }],
  },
  {
    info: {
      id: 'msg_mi_a1',
      role: 'assistant',
      agent: 'build',
      modelID: 'mimo-v2.5',
      providerID: 'opencode-go',
      time: { created: Date.now() - 50_000 },
    },
    parts: [{ id: 'part_a1', type: 'text', text: 'The capital of France is Paris.' }],
  },
  {
    info: {
      id: 'msg_mi_u2',
      role: 'user',
      time: { created: Date.now() - 40_000 },
    },
    parts: [{ id: 'part_u2', type: 'text', text: 'Tell me more.' }],
  },
];

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

function json(res, obj, code = 200) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length });
  res.end(b);
}

const server = http.createServer(async (req, res) => {
  const p = (req.path_url ??= req.url.split('?')[0]);

  try {
    // ---- history (chatserver stubs) ------------------------------------------
    if (p === '/api/history/sessions') return json(res, SESSIONS);
    if (p.endsWith('/errors')) {
      if (req.method === 'GET') return json(res, []);
      return json(res, { ok: true });
    }
    if (p.startsWith('/api/history/session/')) {
      const sid = p.split('/api/history/session/')[1]?.split('/')[0];
      if (sid === SID) return json(res, MESSAGES);
      return json(res, []);
    }

    // ---- engine stubs -------------------------------------------------------
    if (p === '/oc/session/status') return json(res, {});

    // GET /oc/session/{id}/message
    const mMsg = p.match(/^\/oc\/session\/([^/]+)\/message$/);
    if (mMsg && req.method === 'GET') {
      if (mMsg[1] === SID) return json(res, MESSAGES);
      return json(res, []);
    }

    if (p.startsWith('/oc/session/'))
      return json(res, { id: SID, title: 'model-id-probe', revert: null });
    if (p === '/oc/session' && req.method === 'POST')
      return json(res, { id: SID, title: 'model-id-probe', revert: null });
    if (p === '/oc/config/providers')
      return json(res, {
        providers: [
          {
            id: 'opencode-go',
            models: { 'mimo-v2.5': { id: 'mimo-v2.5' } },
          },
        ],
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

function check(c, name, pass, note = '') {
  results.push({ c, name, pass: !!pass, note });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${c} · ${name}${note ? ` — ${note}` : ''}`);
}

try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log(`fake engine on :${PORT}`);

  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => pageErrors.push(e.message));

  try {
    await page.goto(`${BASE}/?session=${SID}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);

    // Wait for the model-id badge to appear on an assistant message
    await page.waitForSelector('.msg:not(.user) .head .model-id', { timeout: 20000 });
    await page.waitForTimeout(1200);

    // Log the header info for each visible message row
    const rows = await page.$$eval('.msg .head', (heads) =>
      heads.slice(0, 6).map((h) =>
        [...h.children].map((c) => c.textContent.trim()).filter(Boolean).join(' | ')
      )
    );
    console.log('message headers:');
    for (const r of rows) console.log(' ', r);

    // ---- assertions
    const badgeCount = await page.locator('.msg:not(.user) .head .model-id').count();
    check('assistant message(s) have model-id badge', badgeCount >= 1, `found ${badgeCount}`);

    const badgeText = await page.locator('.msg:not(.user) .head .model-id').first().innerText();
    check('badge text is "mimo-v2.5"', badgeText.trim() === 'mimo-v2.5', `got "${badgeText.trim()}"`);

    // Check tooltip if present (provider/model)
    const badgeTitle = await page.locator('.msg:not(.user) .head .model-id').first().getAttribute('title');
    if (badgeTitle) {
      check('badge tooltip mentions provider', /opencode-go/i.test(badgeTitle), badgeTitle);
    } else {
      check('badge has tooltip (optional)', true, 'no title attr — not fatal');
    }

    await screenshot(page, 'model-id-verify');
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
