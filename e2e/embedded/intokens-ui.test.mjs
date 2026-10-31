// Integration check for the INPUT (prompt) cost chips in the transcript and the
// InfoPanel's "Prompt cost" block. Unlike intokens.test.mjs (pure math, no
// browser), this one drives the REAL components against an embedded fake engine,
// so it fails if the wiring — message shape, part shape, thresholds, formatting
// — breaks, not just the arithmetic.
//
// Run: node e2e/embedded/intokens-ui.test.mjs        (needs webui/dist built)
//
// Fixture numbers (webui/src/lib/intokens.ts: 0.305 tok/char, tool chip floor
// 30 tok, warn colour at 2000 tok, message chip warn at fresh >= 2000):
//   u1  200 chars of user text                 -> "≈61 in"
//   a1  in 1,644 + cache.read 14,103           -> "15.7K in"  (no fresh warn)
//       tool search  775 chars -> 236 tok      -> "≈236 tok"
//       tool tiny     40 chars ->  12 tok      -> NO chip (under the 30 floor)
//   a2  in 61,785 + cache.read 82,887          -> "144.7K in" + fresh warn
//       tool bash   8,000 chars -> 2,440 tok   -> "≈2.4K tok" + big warn
//   InfoPanel: new 63.4K · re-read 97K · top bash ×1 ≈2.4K, search ×1 ≈236

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, launchBrowser, SHOTS_DIR } from '../helpers/setup.mjs';

const PORT = 8162;
const BASE = `http://127.0.0.1:${PORT}`;

const SID = 'ses_incost01';

const sseClients = new Set();

const MSGS = [
  {
    id: 'u1',
    role: 'user',
    time: { created: Date.now() - 300_000 },
    parts: [{ id: 'p_u1', type: 'text', text: 'q'.repeat(200) }],
  },
  {
    id: 'a1',
    role: 'assistant',
    agent: 'build',
    modelID: 'x-preview-f-free',
    providerID: 'opencode',
    time: { created: Date.now() - 290_000 },
    tokens: { input: 1644, output: 487, reasoning: 0, cache: { read: 14103, write: 0 } },
    parts: [
      {
        id: 'p_a1_search', type: 'tool', tool: 'search',
        state: { status: 'completed', title: 'search notes', output: 'r'.repeat(775) },
      },
      {
        id: 'p_a1_tiny', type: 'tool', tool: 'tiny',
        state: { status: 'completed', output: 'x'.repeat(40) },
      },
      { id: 'p_a1_text', type: 'text', text: 'looking it up' },
    ],
  },
  {
    id: 'a2',
    role: 'assistant',
    agent: 'build',
    modelID: 'x-preview-f-free',
    providerID: 'opencode',
    time: { created: Date.now() - 60_000 },
    tokens: { input: 61785, output: 100, reasoning: 0, cache: { read: 82887, write: 0 } },
    parts: [
      {
        id: 'p_a2_bash', type: 'tool', tool: 'bash',
        state: { status: 'completed', title: 'ls -la', output: 'o'.repeat(8000) },
      },
      { id: 'p_a2_text', type: 'text', text: 'done' },
    ],
  },
];

const SESSIONS = [
  {
    id: SID,
    title: 'Input cost probe',
    created: Date.now() - 300_000,
    updated: Date.now() - 30_000,
    message_count: MSGS.length,
    cost: 0,
    model: 'x-preview-f-free',
    tokens: 144672,
    tokens_generated: 587,
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

const json = (res, obj, code = 200) => {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length });
  res.end(b);
};

const server = http.createServer(async (req, res) => {
  const p = (req.path_url ??= req.url.split('?')[0]);
  try {
    if (p === '/oc/event') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (p === '/api/history/sessions') return json(res, SESSIONS);
    if (p.endsWith('/errors')) return req.method === 'GET' ? json(res, []) : json(res, { ok: true });

    const histMatch = p.match(/^\/api\/history\/session\/([^/?]+)$/);
    if (histMatch) {
      return json(res, MSGS.map((m) => ({
        id: m.id, role: m.role, agent: m.agent ?? null, modelID: m.modelID ?? null,
        time: m.time?.created ?? null, tokens: m.tokens ?? null,
        parts: (m.parts ?? []).map((pt) => ({
          id: pt.id, type: pt.type, text: pt.text, tool: pt.tool ?? null, state: pt.state ?? null,
        })),
      })));
    }

    if (p === '/oc/session/status') return json(res, {});
    const msgMatch = p.match(/^\/oc\/session\/([^/?]+)\/message/);
    if (msgMatch) {
      return json(res, MSGS.map((m) => ({
        info: {
          id: m.id, role: m.role, agent: m.agent, modelID: m.modelID,
          providerID: m.providerID, time: m.time, tokens: m.tokens,
        },
        parts: m.parts ?? [],
      })));
    }
    const sessMatch = p.match(/^\/oc\/session\/([^/?]+)$/);
    if (sessMatch) return json(res, { id: sessMatch[1], title: 'Input cost probe', revert: null });
    if (p === '/oc/config/providers')
      return json(res, { providers: [{ id: 'opencode', models: { 'x-preview-f-free': { id: 'x-preview-f-free' } } }] });
    if (p === '/oc/path') return json(res, { directory: '/workspace' });
    if (p === '/oc/mcp') return json(res, {});
    if (p.startsWith('/oc/')) return json(res, []);

    // statics — strip the /webui/ prefix the shared dist was built with, or every
    // asset 404s and the app never mounts (see AGENTS.md).
    let rel = p === '/' ? '/index.html' : p;
    if (rel.startsWith('/webui/')) rel = rel.slice(6);
    const full = fs.realpathSync(path.join(DIST, rel));
    if (!full.startsWith(fs.realpathSync(DIST)) || !fs.statSync(full).isFile())
      return json(res, { error: 'missing' }, 404);
    const b = fs.readFileSync(full);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] ?? 'application/octet-stream', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
    res.end(b);
  } catch (e) {
    try { json(res, { error: String(e) }, 500); } catch { /* headers already sent (SSE) */ }
  }
});

let fails = 0;
const check = (name, pass, note = '') => {
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${note ? ` — ${note}` : ''}`);
  if (!pass) fails++;
};

const browser = await launchBrowser({ headless: true });
try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('.sidebar .item', { timeout: 15000 });
  await page.getByText('Input cost probe', { exact: false }).first().click();
  await page.waitForSelector('.msg .tool', { timeout: 15000 });
  await page.waitForTimeout(800);

  // ---- transcript: message heads and tool rows, read from the DOM ----------
  const snap = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.msg')].map((el) => ({
      text: el.textContent ?? '',
      html: el.innerHTML,
      tools: [...el.querySelectorAll('.tool > summary')].map((s) => s.textContent ?? ''),
      tokCount: el.querySelectorAll('.badge.tok').length,
      // classList, not innerHTML: Svelte injects its scope hash between class
      // names ("stat in svelte-xyz fresh"), so string matching misses flags
      freshFlag: [...el.querySelectorAll('.stat.in')].some((e) => e.classList.contains('fresh')),
      bigBadges: el.querySelectorAll('.badge.tok.big').length,
    }));
    return rows;
  });
  const none = { text: '', html: '', tools: [], tokCount: -1, freshFlag: false, bigBadges: -1 };
  const user = snap.find((r) => r.text.includes('qqq')) ?? none;
  const a1 = snap.find((r) => r.tools.some((t) => t.includes('search'))) ?? none;
  const a2 = snap.find((r) => r.tools.some((t) => t.includes('bash'))) ?? none;

  check('user row shows its own estimated input ("≈61 in")', user.text.includes('≈61 in'), user.text.slice(0, 160));
  check('user tip names the char count and the estimate', user.html.includes('estimated from 200 chars'), '');

  check('assistant step shows measured prompt total ("15.7K in")', a1.text.includes('15.7K in'), a1.text.slice(0, 160));
  check('its tip splits new vs re-read', a1.html.includes('1,644 input') && a1.html.includes('14,103 re-read'), '');
  check('generated figure is still there ("487 tokens")', a1.text.includes('487 tokens'), '');
  check('moderate fresh input (1,644) is NOT flagged', a1.freshFlag === false, `freshFlag=${a1.freshFlag}`);

  check('big tool result carries its estimated cost ("≈236 tok")', a1.tools.some((t) => t.includes('≈236 tok')), a1.tools.join(' | ').slice(0, 200));
  check('tool tip gives chars + re-send warning', a1.html.includes('775 chars of output') && a1.html.includes('re-sends it'), '');
  check('exactly ONE cost chip in that row — the 40-char result is under the 30-tok floor', a1.tokCount === 1, `count=${a1.tokCount}`);

  check('cache-miss step totals big ("144.7K in")', a2.text.includes('144.7K in'), a2.text.slice(0, 160));
  check('and flags the fresh part (61,785 new)', a2.freshFlag === true, `freshFlag=${a2.freshFlag}`);
  check('8 KB result flags as a big dump ("≈2.4K tok")', a2.tools.some((t) => t.includes('≈2.4K tok')), a2.tools.join(' | ').slice(0, 200));
  check('one cost chip on the a2 row', a2.tokCount === 1, `count=${a2.tokCount}`);
  check('236 tok stays uncoloured, 2,440 tok turns to warn', a1.bigBadges === 0 && a2.bigBadges === 1,
    `a1 big=${a1.bigBadges}, a2 big=${a2.bigBadges}`)
  // the class alone proves nothing — check the colour actually differs
  const colors = await page.evaluate(() => {
    const all = [...document.querySelectorAll('.badge.tok')]
    return all.map((e) => getComputedStyle(e).color)
  })
  check('warn colour really applies (computed color differs)',
    colors.length === 2 && colors[0] !== colors[1], colors.join(' vs '));

  // ---- InfoPanel: Prompt cost block ---------------------------------------
  await page.waitForSelector('.panel .grid', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const panel = await page.evaluate(() => {
    const secs = [...document.querySelectorAll('.panel .sec')];
    const sec = secs.find((s) => (s.textContent ?? '').includes('Prompt cost'));
    if (!sec) return null;
    const grid = sec.nextElementSibling;
    return { head: sec.textContent ?? '', grid: grid?.textContent ?? '' };
  });
  check('InfoPanel has a Prompt cost section', !!panel, JSON.stringify(panel)?.slice(0, 120));
  check('section is honest about its window', !!panel && /last 3/.test(panel.head), panel?.head ?? '');
  check('new = sum of input+cache-write (63.4K)', !!panel && panel.grid.includes('63.4K'), panel?.grid ?? '');
  check('re-read = sum of cache.read (97K)', !!panel && panel.grid.includes('97K'), panel?.grid ?? '');
  check('biggest injector listed (bash ×1 ≈2.4K)', !!panel && /bash ×1/.test(panel.grid) && panel.grid.includes('≈2.4K'), panel?.grid ?? '');

  await page.screenshot({ path: path.join(SHOTS_DIR, 'intokens-ui.png'), fullPage: false });

  if (pageErrors.length) {
    console.log(`\npage errors (${pageErrors.length}):`);
    for (const e of [...new Set(pageErrors)].slice(0, 5)) console.log('  •', e.slice(0, 200));
    fails += 1;
  }
} finally {
  await browser.close();
  server.close();
}

console.log(fails ? `\nFAILURES: ${fails}` : '\nall intokens-ui assertions passed');
process.exit(fails ? 1 : 0);
