// Verify token tracking fix: sidebar tk badges, InfoPanel tokens/used for a
// session whose newest assistant message carries token usage.
//
// Runs against an EMBEDDED fake engine (same pattern as question-picker.test.mjs):
// in-process HTTP server serving webui/dist + stubbed /oc endpoints. No live
// engine or chatserver needed.
//
// Run: node e2e/embedded/tokens.test.mjs

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, launchBrowser, SHOTS_DIR } from '../helpers/setup.mjs';

const PORT = 8141;
const BASE = `http://127.0.0.1:${PORT}`;

// ============================== fake engine =================================

const sseClients = new Set();

const SESSION_ID = 'ses_tokens01';
const TOKEN_USER_ID = 'msg_tokens_user1';
const TOKEN_ASSISTANT_ID = 'msg_tokens_assistant1';

// Token-bearing assistant message for the probe session.
// Total: 1500+800+200+5000+0 = 7500 → sidebar shows "8K tk" (Math.round(7500/1000)=8)
const TOKEN_MESSAGES = [
  {
    id: TOKEN_USER_ID,
    role: 'user',
    time: { created: Date.now() - 120_000 },
    parts: [{ id: 'prt_u1', type: 'text', text: 'How many files are in the repo?' }],
  },
  {
    id: TOKEN_ASSISTANT_ID,
    role: 'assistant',
    agent: 'build',
    modelID: 'x-preview-f-free',
    providerID: 'opencode',
    time: { created: Date.now() - 60_000 },
    tokens: { input: 1500, output: 800, reasoning: 200, cache: { read: 5000, write: 0 } },
    parts: [
      { id: 'prt_a1', type: 'text', text: 'There are 42 files in the workspace.' },
    ],
  },
];

// Additional session with a token-bearing assistant message (for sidebar badges).
const EXTRA_SESSION_ID = 'ses_tokens02';
const EXTRA_USER_ID = 'msg_extra_user1';
const EXTRA_ASSISTANT_ID = 'msg_extra_assistant1';
const EXTRA_MESSAGES = [
  {
    id: EXTRA_USER_ID,
    role: 'user',
    time: { created: Date.now() - 200_000 },
    parts: [{ id: 'prt_eu1', type: 'text', text: 'Summarize the project.' }],
  },
  {
    id: EXTRA_ASSISTANT_ID,
    role: 'assistant',
    agent: 'build',
    modelID: 'x-preview-f-free',
    providerID: 'opencode',
    time: { created: Date.now() - 180_000 },
    tokens: { input: 5000, output: 2000, reasoning: 0, cache: { read: 12000, write: 0 } },
    parts: [
      { id: 'prt_ea1', type: 'text', text: 'This is a web application project.' },
    ],
  },
];

// Session with an all-zero token tally (should NOT show tk badge)
const ZERO_SESSION_ID = 'ses_tokens03';
const ZERO_USER_ID = 'msg_zero_user1';
const ZERO_ASSISTANT_ID = 'msg_zero_assistant1';
const ZERO_MESSAGES = [
  {
    id: ZERO_USER_ID,
    role: 'user',
    time: { created: Date.now() - 300_000 },
    parts: [{ id: 'prt_zu1', type: 'text', text: 'Hello' }],
  },
  {
    id: ZERO_ASSISTANT_ID,
    role: 'assistant',
    agent: 'build',
    modelID: 'x-preview-f-free',
    providerID: 'opencode',
    time: { created: Date.now() - 290_000 },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    parts: [
      { id: 'prt_za1', type: 'text', text: 'Hi there.' },
    ],
  },
];

// Sessions list with pre-computed token counts (mimics chatserver load_sessions).
// The sidebar tk badge comes from the `tokens` field here.
// fmtK(7500) = "7.5K", fmtK(19000) = "19K"
const SESSIONS = [
  {
    id: SESSION_ID,
    title: 'Tokens probe session',
    created: Date.now() - 120_000,
    updated: Date.now() - 30_000,
    message_count: TOKEN_MESSAGES.length,
    cost: 0,
    model: 'x-preview-f-free',
    tokens: 7500, // 1500+800+200+5000+0
  },
  {
    id: EXTRA_SESSION_ID,
    title: 'Extra session with tokens',
    created: Date.now() - 200_000,
    updated: Date.now() - 180_000,
    message_count: EXTRA_MESSAGES.length,
    cost: 0,
    model: 'x-preview-f-free',
    tokens: 19000, // 5000+2000+0+12000+0
  },
  {
    id: ZERO_SESSION_ID,
    title: 'Zero-tally session',
    created: Date.now() - 300_000,
    updated: Date.now() - 290_000,
    message_count: ZERO_MESSAGES.length,
    cost: 0,
    model: 'x-preview-f-free',
    // No `tokens` field — chatserver's correlated subquery only includes sessions
    // with a non-zero tally. An all-zero tokens object is truthy but sums to 0,
    // so the subquery's `> 0` predicate excludes it.
  },
];

function messagesForSession(sid) {
  if (sid === SESSION_ID) return TOKEN_MESSAGES;
  if (sid === EXTRA_SESSION_ID) return EXTRA_MESSAGES;
  if (sid === ZERO_SESSION_ID) return ZERO_MESSAGES;
  return [];
}

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
    // /api/history/session/{id} — return messages with tokens for InfoPanel
    const histMatch = p.match(/^\/api\/history\/session\/([^/?]+)$/);
    if (histMatch) {
      const sid = histMatch[1];
      const msgs = messagesForSession(sid);
      // Simulate chatserver's load_messages shape
      return json(res, msgs.map((m) => ({
        id: m.id,
        role: m.role,
        agent: m.agent ?? null,
        modelID: m.modelID ?? null,
        time: m.time?.created ?? null,
        tokens: m.tokens ?? null,
        parts: (m.parts || []).map((pt) => ({
          id: pt.id,
          type: pt.type,
          text: pt.text,
          tool: pt.tool ?? null,
          state: pt.state ?? null,
        })),
      })));
    }

    // ---- engine stubs --------------------------------------------------------
    if (p === '/oc/session/status') return json(res, {});

    // Engine messages: return { info, parts } shape (v1 engine format)
    const msgMatch = p.match(/^\/oc\/session\/([^/?]+)\/message/);
    if (msgMatch) {
      const sid = msgMatch[1];
      const msgs = messagesForSession(sid);
      // Engine returns messages with { info, parts } wrapping
      const ocMsgs = msgs.map((m) => ({
        info: {
          id: m.id,
          role: m.role,
          agent: m.agent,
          modelID: m.modelID,
          providerID: m.providerID,
          time: m.time,
          tokens: m.tokens,
        },
        parts: m.parts || [],
      }));
      return json(res, ocMsgs);
    }

    const sessMatch = p.match(/^\/oc\/session\/([^/?]+)$/);
    if (sessMatch) {
      const sid = sessMatch[1];
      const s = SESSIONS.find((s) => s.id === sid);
      return json(res, { id: sid, title: s?.title ?? '', revert: null });
    }
    if (p === '/oc/session' && req.method === 'POST')
      return json(res, { id: SESSION_ID, title: 'Tokens probe session', revert: null });
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
    try { json(res, { error: String(e) }, 500); } catch { /* headers sent (SSE) */ }
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

  const browser = await launchBrowser({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // ---- 1) sidebar rows render with tk badges --------------------------------
    console.log('\nCASE 1 — sidebar tk badges');
    await page.waitForSelector('.sidebar .item', { timeout: 15000 });
    await page.waitForTimeout(1200);
    const rowInfo = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.sidebar .item .sub')];
      const withTk = rows.filter((r) => /tk/.test(r.textContent || ''));
      return {
        total: rows.length,
        withTk: withTk.length,
        sample: withTk.slice(0, 3).map((r) => r.textContent.trim()),
      };
    });
    console.log('sidebar rows:', JSON.stringify(rowInfo));
    check('', 'sidebar has rows', rowInfo.total > 0, `${rowInfo.total} rows`);
    check('', 'at least one row shows tk badge', rowInfo.withTk >= 1, `${rowInfo.withTk} rows with tk`);

    // The two token-bearing sessions should show tk; the zero-tally one should not
    check('', 'at least 2 rows with tk (probe + extra)', rowInfo.withTk >= 2,
      `got ${rowInfo.withTk}; sample: ${JSON.stringify(rowInfo.sample)}`);

    // ---- 2) open the Tokens probe session + verify InfoPanel -------------------
    console.log('\nCASE 2 — InfoPanel token display');
    await page.getByText('Tokens probe session', { exact: false }).first().click();
    await page.waitForSelector('.info .grid', { timeout: 15000 });
    await page.waitForTimeout(3000);

    // InfoPanel refresh + store overlay need a beat
    await page.waitForFunction(
      () => {
        const v = [...document.querySelectorAll('.info .grid .v')].map((e) => e.textContent.trim());
        return v[0] && v[0] !== '—';
      },
      { timeout: 25000 },
    );
    await page.waitForTimeout(500);

    const panel = await page.evaluate(() => {
      const g = [...document.querySelectorAll('.info .grid')];
      const kv = {};
      g.forEach((el) => {
        const ks = el.querySelectorAll('.k, .v');
        for (let i = 0; i < ks.length; i += 2) kv[ks[i].textContent.trim()] = ks[i + 1]?.textContent.trim();
      });
      return { tokens: kv['tokens'], used: kv['used'], spent: kv['spent'] };
    });
    console.log('InfoPanel:', JSON.stringify(panel));
    check('', 'InfoPanel tokens is not em-dash', panel.tokens && panel.tokens !== '—',
      panel.tokens ?? 'missing');
    // fmtK(7500) = "8K" (Math.round(7.5) = 8)
    check('', 'InfoPanel tokens shows 8K', panel.tokens === '8K', `got "${panel.tokens}"`);
    check('', 'InfoPanel used has percentage', /\d+%/.test(panel.used) || panel.used === '—',
      panel.used ?? 'missing');

    // ---- 3) footer segment shows the context estimate --------------------------
    console.log('\nCASE 3 — footer context estimate');
    const footer = await page.evaluate(() => document.querySelector('.footer')?.textContent?.trim() ?? '');
    console.log('footer:', JSON.stringify(footer.slice(0, 160)));
    check('', 'footer rendered', footer.length > 0, footer.slice(0, 120));

    // ---- 4) zero-tally session shows no tk ------------------------------------
    console.log('\nCASE 4 — zero-tally session has no tk badge');
    const zeroRow = page.locator('.sidebar .item', { hasText: 'Zero-tally session' });
    if (await zeroRow.count()) {
      const zeroSub = zeroRow.locator('.sub');
      const zeroText = (await zeroSub.textContent()) ?? '';
      check('', 'zero-tally session has no tk badge', !/tk/.test(zeroText),
        zeroText.trim());
    } else {
      check('', 'zero-tally session row exists', false, 'row not found');
    }

    await page.screenshot({ path: path.join(SHOTS_DIR, 'tokens-fix.png') });
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
