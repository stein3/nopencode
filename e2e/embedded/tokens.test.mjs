// Verify token tracking: sidebar GENERATED-token badges (output+reasoning,
// incl. subagent descendants), InfoPanel tokens/used (context view) for a
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

const PORT = 8182;
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

// id of the live-overlay probe session — declared here because SESSIONS below
// references it (a `const` further down is in the temporal dead zone: the
// module would throw before the server ever listens).
const GENLIVE_ID = 'ses_genlive';

// Sessions list with pre-computed token counts (mimics chatserver load_sessions:
// `tokens` = newest-message CONTEXT estimate, `tokens_generated` = sum of
// output+reasoning over all assistant messages). The sidebar badge reads
// `tokens_generated`; InfoPanel's "tokens" still reads the context estimate.
//   probe:  800 out + 200 reasoning = 1000  -> "1K gen"  (context 7500 -> 8K)
//   extra: 2000 out +    0 reasoning = 2000 -> "2K gen"  (context 19000 -> 19K)
//   parent: own 5000 + child 2500 (subagent, separate row) = 7500 -> "8K gen"
//   child:  SELF-ONLY 2500 -> "3K gen" (fmtK = Math.round(n/1000), so 2500
//           renders 3K — and 3K on the child proves no parent rollup leaks in)
const SESSIONS = [
  {
    id: SESSION_ID,
    title: 'Tokens probe session',
    created: Date.now() - 120_000,
    updated: Date.now() - 30_000,
    message_count: TOKEN_MESSAGES.length,
    cost: 0,
    model: 'x-preview-f-free',
    tokens: 7500, // 1500+800+200+5000+0 — context view, sidebar must NOT use it
    tokens_generated: 1000, // 800+200
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
    tokens_generated: 2000, // 2000+0
  },
  {
    id: ZERO_SESSION_ID,
    title: 'Zero-tally session',
    created: Date.now() - 300_000,
    updated: Date.now() - 290_000,
    message_count: ZERO_MESSAGES.length,
    cost: 0,
    model: 'x-preview-f-free',
    // No `tokens` / `tokens_generated` field — the server only emits them for a
    // non-zero tally. An all-zero tokens object is truthy but sums to 0, so the
    // projection's `> 0` predicate excludes it.
  },
  // ---- subagent rollup: engine session totals are SELF-ONLY, so the parent
  // row must add the child's own total (webui/src/lib/gentokens.ts) ----------
  {
    id: 'ses_genparent',
    title: 'Gen rollup parent',
    created: Date.now() - 400_000,
    updated: Date.now() - 390_000,
    message_count: 4,
    cost: 0,
    model: 'x-preview-f-free',
    tokens_generated: 5000,
  },
  {
    id: 'ses_genchild',
    title: 'Gen rollup child',
    parent: 'ses_genparent',
    agent: 'explore',
    created: Date.now() - 395_000,
    updated: Date.now() - 391_000,
    message_count: 2,
    cost: 0,
    model: 'x-preview-f-free',
    tokens_generated: 2500,
  },
  // live overlay probe: deliberately STALE snapshot — opening the tab must
  // replace it with the sum of the session's own messages (900)
  {
    id: GENLIVE_ID,
    title: 'Gen live overlay',
    created: Date.now() - 500_000,
    updated: Date.now() - 498_000,
    message_count: 2,
    cost: 0,
    model: 'x-preview-f-free',
    tokens_generated: 10,
  },
];

// Message set for the live-overlay probe: a STALE snapshot below, corrected by
// the message fetch the webui makes when the tab opens (output+reasoning =
// 700+200 = 900; the user row's 5 must not count).
const GENLIVE_MESSAGES = [
  { id: 'gl_u1', role: 'user', time: { created: Date.now() - 500_000 },
    tokens: { input: 100, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    parts: [{ id: 'gl_pu', type: 'text', text: 'go' }] },
  { id: 'gl_a1', role: 'assistant', agent: 'build', modelID: 'x-preview-f-free',
    providerID: 'opencode', time: { created: Date.now() - 499_000 },
    tokens: { input: 12000, output: 700, reasoning: 200, cache: { read: 30000, write: 0 } },
    parts: [{ id: 'gl_pa', type: 'text', text: 'done' }] },
];

function messagesForSession(sid) {
  if (sid === SESSION_ID) return TOKEN_MESSAGES;
  if (sid === EXTRA_SESSION_ID) return EXTRA_MESSAGES;
  if (sid === ZERO_SESSION_ID) return ZERO_MESSAGES;
  if (sid === GENLIVE_ID) return GENLIVE_MESSAGES;
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
    // the rollup fixture needs the SUBAGENT row visible: the sidebar hides
    // @agent sessions by default (pref `opencode.hideSubagents`, stored '1'/'0')
    await page.addInitScript(() => localStorage.setItem('opencode.hideSubagents', '0'));
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // ---- 1) sidebar rows render with GENERATED badges -----------------------
    console.log('\nCASE 1 — sidebar generated-token badges');
    await page.waitForSelector('.sidebar .item', { timeout: 15000 });
    await page.waitForTimeout(1200);
    // Shown subagents are NESTED under their parent and start collapsed
    // (flattenTree + the in-memory subExpanded set), so the rollup child row
    // only enters the DOM once its parent's chevron is clicked.
    const chev = page.locator('.item[title="Gen rollup parent"] .chev');
    if (await chev.count()) {
      await chev.first().click();
      await page.waitForTimeout(600);
    }
    const rowInfo = await page.evaluate(() => {
      const out = {};
      for (const it of [...document.querySelectorAll('.sidebar .item')]) {
        out[it.getAttribute('title') ?? ''] =
          it.querySelector('.smeta')?.textContent?.trim() ?? '';
      }
      return out;
    });
    console.log('sidebar rows:', JSON.stringify(rowInfo));
    const metas = Object.values(rowInfo);
    check('', 'sidebar has rows', metas.length > 0, `${metas.length} rows`);
    check('', 'at least one row shows a gen badge', metas.some((m) => /gen\b/.test(m)),
      JSON.stringify(metas.slice(0, 3)));

    // the sidebar must show generated (output+reasoning), NOT the context view
    const probe = rowInfo['Tokens probe session'] ?? '';
    check('', 'probe row badge is generated (1K gen)', /1K gen/.test(probe), probe);
    check('', 'probe row does NOT show the 8K context view', !/8K/.test(probe), probe);
    const extra = rowInfo['Extra session with tokens'] ?? '';
    check('', 'extra row badge is generated (2K gen)', /2K gen/.test(extra), extra);
    check('', 'extra row does NOT show the 19K context view', !/19K/.test(extra), extra);

    // engine session totals are self-only: the parent row must include the
    // subagent's own total (5000 + 2500 = 7500 -> 8K)
    const parent = rowInfo['Gen rollup parent'] ?? '';
    check('', 'parent row = own + subagent (8K gen)', /8K gen/.test(parent), parent);
    // strict on purpose: a missing child row must FAIL, not pass on the empty
    // string — otherwise this check is vacuous whenever subagents get hidden.
    // 3K (self-only 2500), never the parent's 8K: engine totals are self-only.
    const child = rowInfo['Gen rollup child'] ?? '';
    check('', 'child row shows its own number only (3K gen, no parent rollup)',
      /3K gen/.test(child) && !/8K/.test(child), child || 'child row not rendered');
    // ---- 2) open the Tokens probe session + verify InfoPanel -------------------
    console.log('\nCASE 2 — InfoPanel token display');
    await page.getByText('Tokens probe session', { exact: false }).first().click();
    await page.waitForSelector('.panel .grid', { timeout: 15000 });
    await page.waitForTimeout(3000);

    // InfoPanel refresh + store overlay need a beat
    await page.waitForFunction(
      () => {
        const v = [...document.querySelectorAll('.panel .grid .v')].map((e) => e.textContent.trim());
        return v[0] && v[0] !== '—';
      },
      { timeout: 25000 },
    );
    await page.waitForTimeout(500);

    const panel = await page.evaluate(() => {
      const g = [...document.querySelectorAll('.panel .grid')];
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

    // ---- 4) zero-tally session shows no gen badge ---------------------------
    console.log('\nCASE 4 — zero-tally session has no gen badge');
    const zeroRow = page.locator('.sidebar .item', { hasText: 'Zero-tally session' });
    if (await zeroRow.count()) {
      const zeroSub = zeroRow.locator('.sub');
      const zeroText = (await zeroSub.textContent()) ?? '';
      check('', 'zero-tally session has no gen badge', !/gen\b/.test(zeroText),
        zeroText.trim());
    } else {
      check('', 'zero-tally session row exists', false, 'row not found');
    }

    await page.screenshot({ path: path.join(SHOTS_DIR, 'tokens-fix.png') });

    // ---- 5) live value beats the stale snapshot -----------------------------
    // The history row is a snapshot; opening the tab makes the webui sum the
    // session's own messages (output+reasoning = 900) and that must win, so an
    // open session's badge stays current without a list refresh.
    console.log('\nCASE 5 — live overlay replaces the stale snapshot');
    await page.getByText('Gen live overlay', { exact: false }).first().click();
    let liveMeta = '';
    try {
      await page.waitForFunction(() => {
        for (const it of [...document.querySelectorAll('.sidebar .item')]) {
          if ((it.getAttribute('title') ?? '').startsWith('Gen live overlay')) {
            const m = it.querySelector('.smeta')?.textContent ?? '';
            if (/900 gen/.test(m)) return true;
          }
        }
        return false;
      }, { timeout: 20000 });
    } catch { /* fall through to the assertion below */ }
    liveMeta = await page.evaluate(() => {
      for (const it of [...document.querySelectorAll('.sidebar .item')]) {
        if ((it.getAttribute('title') ?? '').startsWith('Gen live overlay'))
          return it.querySelector('.smeta')?.textContent?.trim() ?? '';
      }
      return '(row not found)';
    });
    check('', 'open session shows the message-derived total (900 gen), not the stale 10',
      /900 gen/.test(liveMeta), liveMeta);
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
