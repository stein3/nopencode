// verify-model-badge.mjs — user messages show the model-id badge like
// assistant rows (msgModel: flat assistant fields + nested user `model`).
// Runs against an EMBEDDED fake engine (same pattern as question-picker.test.mjs),
// so no live engine/chatserver is needed.
//
// Run: node e2e/embedded/model-badge.test.mjs

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, launchBrowser, SHOTS_DIR } from '../helpers/setup.mjs';

const PORT = 8152;
const BASE = `http://127.0.0.1:${PORT}`;

// ============================== session IDs ================================

const PROBE_SID = 'ses_mbprobe1';
const PARITY_SID = 'ses_mbparity1';
const RETRO_SID = 'ses_mbretro1';

// ============================== model fixtures =============================

const MODELS = [
  { providerID: 'opencode-go', modelID: 'ox-alpha-free' },
  { providerID: 'opencode', modelID: 'x-preview-f-free' },
];

// ============================== fake engine =================================

const PROBE_MSGS = [
  // User msg 0: nested model shape (user messages use data.model = {providerID, modelID})
  {
    info: {
      id: 'msg_mb_probe0',
      role: 'user',
      time: { created: Date.now() - 60_000 },
      model: { providerID: 'opencode-go', modelID: 'ox-alpha-free' },
    },
    parts: [{ id: 'part_mb_p0', type: 'text', text: 'badge probe via opencode-go/ox-alpha-free' }],
  },
  // User msg 1: nested model shape
  {
    info: {
      id: 'msg_mb_probe1',
      role: 'user',
      time: { created: Date.now() - 30_000 },
      model: { providerID: 'opencode', modelID: 'x-preview-f-free' },
    },
    parts: [{ id: 'part_mb_p1', type: 'text', text: 'badge probe via opencode/x-preview-f-free' }],
  },
];

const PARITY_MSGS = [
  // Assistant msg with flat modelID + providerID (assistant shape)
  {
    info: {
      id: 'msg_mb_parity0',
      role: 'assistant',
      time: { created: Date.now() - 90_000 },
      modelID: 'x-preview-f-free',
      providerID: 'opencode',
    },
    parts: [{ id: 'part_mb_par0', type: 'text', text: 'parity response' }],
  },
];

const RETRO_MSGS = [
  // Old user msg with nested model.modelID (retro badge coverage)
  {
    info: {
      id: 'msg_mb_retro0',
      role: 'user',
      time: { created: Date.now() - 120_000 },
      model: { providerID: 'opencode-go', modelID: 'ox-alpha-free' },
    },
    parts: [{ id: 'part_mb_ret0', type: 'text', text: 'retro user message' }],
  },
];

const SESSIONS = [
  {
    id: PROBE_SID,
    title: 'model-badge probe',
    created: Date.now() - 60_000,
    updated: Date.now() - 5_000,
    message_count: 2,
    cost: 0,
  },
  {
    id: PARITY_SID,
    title: 'model-badge parity',
    created: Date.now() - 120_000,
    updated: Date.now() - 90_000,
    message_count: 1,
    cost: 0,
  },
  {
    id: RETRO_SID,
    title: 'model-badge retro',
    created: Date.now() - 180_000,
    updated: Date.now() - 120_000,
    message_count: 1,
    cost: 0,
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
    // ---- history (chatserver stubs) ------------------------------------------
    if (p === '/api/history/sessions') {
      return json(res, SESSIONS);
    }
    if (p.endsWith('/errors')) {
      if (req.method === 'GET') return json(res, []);
      return json(res, { ok: true });
    }
    if (p.startsWith('/api/history/session/')) {
      const sid = p.split('/api/history/session/')[1]?.split('/')[0];
      if (sid === PROBE_SID) {
        // chatserver load_messages format: flat objects with time as number,
        // modelID as flat field (extracted from nested model.modelID)
        return json(res, PROBE_MSGS.map((m) => ({
          id: m.info.id,
          role: m.info.role,
          agent: m.info.agent ?? null,
          modelID: m.info.model?.modelID ?? null,
          time: m.info.time?.created ?? null,
          parts: m.parts.map((pt) => ({
            id: pt.id,
            type: pt.type,
            text: pt.text,
            tool: pt.tool ?? null,
            state: pt.state ?? null,
          })),
        })));
      }
      return json(res, []);
    }

    // ---- SSE -----------------------------------------------------------------
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

    // ---- engine stubs (order matters: /status before /session/{id}) ----------
    if (p === '/oc/session/status') return json(res, {});

    // /oc/session/{id}/message — return messages per session
    if (p.startsWith('/oc/session/') && p.endsWith('/message')) {
      const sid = p.split('/')[3];
      if (sid === PROBE_SID) return json(res, PROBE_MSGS);
      if (sid === PARITY_SID) return json(res, PARITY_MSGS);
      if (sid === RETRO_SID) return json(res, RETRO_MSGS);
      return json(res, []);
    }

    // GET /oc/session/{id} — single session
    if (p.match(/^\/oc\/session\/[^/]+$/) && req.method === 'GET') {
      const sid = p.split('/')[3];
      const s = SESSIONS.find((x) => x.id === sid);
      if (s) return json(res, { id: s.id, title: s.title, revert: null });
      return json(res, { error: 'not found' }, 404);
    }

    // POST /oc/session — create session
    if (p === '/oc/session' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const id = 'ses_mbcreated_' + Date.now();
      return json(res, { id, title: body.title || 'new session', revert: null });
    }

    if (p === '/oc/config/providers')
      return json(res, {
        providers: [
          {
            id: 'opencode-go',
            models: { 'ox-alpha-free': { id: 'ox-alpha-free' } },
          },
          {
            id: 'opencode',
            models: { 'x-preview-f-free': { id: 'x-preview-f-free' } },
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

// ================================ checks ====================================

const results = [];
let pageErrors = [];

function check(c, name, pass, note = '') {
  results.push({ c, name, pass: !!pass, note });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${c} · ${name}${note ? ` — ${note}` : ''}`);
}

// ================================ run =======================================

try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log(`fake engine listening on ${BASE}`);

  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1900 } }); // tall: content-visibility keeps rows painted
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const pane = page.locator('.tabpane[style*="flex"]'); // active pane only

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForSelector('.sidebar .item', { timeout: 10000 });
    await page.waitForTimeout(1200);

    // ---- [1] probe session: both user rows show the right badge + provider/model tooltip
    console.log('\n[1] probe session: user model-id badges');
    await page.click(`.sidebar .item[title="model-badge probe"]`);
    await pane.locator('.msg.user').first().waitFor({ timeout: 10000 });
    const userRows = pane.locator('.msg.user');
    check('1', 'probe has 2 user rows', (await userRows.count()) === 2);
    for (let i = 0; i < MODELS.length; i++) {
      const badge = userRows.nth(i).locator('.model-id');
      const txt = (await badge.textContent()).trim();
      const tip = await badge.getAttribute('title');
      const want = MODELS[i];
      check(`1.${i + 1}`, 'user row badge text', txt === want.modelID, `got "${txt}" want "${want.modelID}"`);
      check(
        `1.${i + 1}`,
        'tooltip is provider/model',
        tip === `${want.providerID}/${want.modelID}`,
        `got "${tip}"`,
      );
    }

    // ---- [2] assistant badge parity
    console.log('\n[2] assistant badge parity');
    await page.click(`.sidebar .item[title="model-badge parity"]`);
    await pane.locator('.msg:not(.user)').first().waitFor({ timeout: 10000 });
    const aidInfo = PARITY_MSGS[0].info;
    const aidRow = pane.locator(`#m-${aidInfo.id}`);
    if ((await aidRow.count()) === 1) {
      const abadge = aidRow.locator('.model-id');
      if ((await abadge.count()) === 1) {
        const txt = (await abadge.textContent()).trim();
        const tip = await abadge.getAttribute('title');
        check('2', 'assistant badge text', txt === aidInfo.modelID, `got "${txt}" want "${aidInfo.modelID}"`);
        check('2', 'assistant tooltip provider/model', tip === `${aidInfo.providerID}/${aidInfo.modelID}`, `got "${tip}"`);
      } else {
        check('2', 'assistant badge element exists', false, 'no .model-id in assistant row');
      }
    } else {
      // assistant row outside the newest-80 window — accept any visible assistant badge
      const anyBadge = pane.locator('.msg:not(.user) .model-id').first();
      check('2', 'some assistant badge renders', (await anyBadge.count()) === 1);
    }
    // visual parity shot
    const uRow = pane.locator('.msg.user').last();
    if (await uRow.count()) await uRow.screenshot({ path: `${SHOTS_DIR}/model-badge-user-old.png` }).catch(() => {});

    // ---- [3] retroactive win: old session's user rows now show badges
    console.log('\n[3] retro session: old user badges');
    await page.click(`.sidebar .item[title="model-badge retro"]`);
    await pane.locator('.msg.user .head').first().waitFor({ timeout: 10000 });
    await page.waitForTimeout(500);
    const badges = pane.locator('.msg.user .model-id');
    const n = await badges.count();
    check('3', 'old session shows >=1 user badge', n >= 1, `${n} badges`);
    if (n) {
      // textContent: content-visibility:auto skips offscreen paint, which makes
      // innerText '' even though the span exists with correct data
      const txt = (await badges.first().textContent()).trim();
      const tip = await badges.first().getAttribute('title');
      check('3', 'old-session user badge non-empty', !!txt, `"${txt}"`);
      console.log(`[3] first old-session user badge: "${txt}" title="${tip}"`);
    }

    // ---- [4] element screenshots of probe user rows for parity
    console.log('\n[4] screenshots');
    await page.click(`.sidebar .item[title="model-badge probe"]`);
    await pane.locator('.msg.user').first().waitFor({ timeout: 10000 });
    await page.mouse.move(640, 900);
    await page.mouse.wheel(0, -400); // real wheel-up so stick-to-bottom stands down
    await page.waitForTimeout(300);
    await pane.locator('.msg.user').nth(0).screenshot({ path: `${SHOTS_DIR}/model-badge-user1.png` });
    await pane.locator('.msg.user').nth(1).screenshot({ path: `${SHOTS_DIR}/model-badge-user2.png` });
    console.log('shots saved:', `${SHOTS_DIR}/model-badge-user{1,2}.png`);
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
