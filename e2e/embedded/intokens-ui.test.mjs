// Integration check for the transcript's PER-BLOCK token chips, tool cost badges
// and the InfoPanel's "Prompt cost" block. Unlike intokens.test.mjs (pure math,
// no browser), this one drives the REAL components against an embedded fake
// engine, so it fails if the wiring — message shape, part shape, thresholds,
// formatting — breaks, not just the arithmetic.
//
// Run: node e2e/embedded/intokens-ui.test.mjs        (needs webui/dist built)
//
// The rule this pins: a block carries its OWN number. The engine measures usage
// per step (one assistant message), so `reasoning` lands on the thinking block
// and `output` on the reply text; a step with several blocks of one kind splits
// its measured total by character share and marks it ≈. The step's PROMPT total
// is shown nowhere in the transcript any more — it is the context the footer
// already reports, and colouring a block by its `fresh` part keyed the figure to
// the PREVIOUS turn's output.
//
// Fixture numbers (webui/src/lib/intokens.ts: 0.305 tok/char, tool chip floor
// 30 tok, warn colour at 2000 tok):
//   u1  200 chars of user text, no usage        -> "≈61 tok" (estimate)
//   a1  reasoning 513 / output 487, 10.0s       -> thinking "513 tok", text
//       "487 tok" + "10.0s" + "100.00 t/s" (gen 1000 / 10 s)
//       tool search  775 chars -> 236 tok       -> "≈236 tok"
//       tool tiny     40 chars ->  12 tok       -> NO chip (under the 30 floor)
//   a2  two thinking blocks, measured 1000, 300/700 chars
//                                                -> "≈300 tok" + "≈700 tok", both ≈
//       tool bash  8,000 chars -> 2,440 tok     -> "≈2.4K tok" + big warn
//       output 100, no completed time           -> "100 tok", NO clock chips
//   InfoPanel: new 63.4K · re-read 97K · top bash ×1 ≈2.4K, search ×1 ≈236

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, launchBrowser, SHOTS_DIR } from '../helpers/setup.mjs';

const PORT = 8162;
const BASE = `http://127.0.0.1:${PORT}`;

const SID = 'ses_incost01';

const sseClients = new Set();

const T_A1 = Date.now() - 290_000;
const T_A2 = Date.now() - 60_000;

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
    // completed set: 10.0 s of agent time (no tool state.time in this row, so
    // splitTiming attributes the whole window to generation)
    time: { created: T_A1, completed: T_A1 + 10_000 },
    tokens: { input: 1644, output: 487, reasoning: 513, cache: { read: 14103, write: 0 } },
    parts: [
      { id: 'p_a1_think', type: 'reasoning', text: 't'.repeat(600) },
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
    time: { created: T_A2 }, // no completed -> the step has no clock to stamp
    tokens: { input: 61785, output: 100, reasoning: 1000, cache: { read: 82887, write: 0 } },
    parts: [
      { id: 'p_a2_th1', type: 'reasoning', text: 'a'.repeat(300) },
      { id: 'p_a2_th2', type: 'reasoning', text: 'b'.repeat(700) },
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
    tokens_generated: 1100,
    tokens_input: 63429,
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
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
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

// whitespace collapsed: the chips sit in a flex row, so the DOM text has the
// template's newlines between them
const flat = (s) => (s ?? '').replace(/\s+/g, ' ').trim();

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

  // ---- transcript: read each block's own chips from the DOM ----------------
  const snap = await page.evaluate(() => {
    const flat = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
    const rows = [...document.querySelectorAll('.msg')].map((el) => ({
      text: el.textContent ?? '',
      html: el.innerHTML,
      // the header must carry NO numbers: its "in" figure was the context the
      // footer already shows, and its amber keyed off the previous turn
      head: flat(el.querySelector('.head')?.textContent),
      think: [...el.querySelectorAll('details.thinking > summary')].map((s) => flat(s.textContent)),
      blocks: [...el.querySelectorAll('.blkstats')].map((b) => flat(b.textContent)),
      tools: [...el.querySelectorAll('.tool > summary')].map((s) => flat(s.textContent)),
      tokCount: el.querySelectorAll('.badge.tok').length,
      // classList, not innerHTML: Svelte injects its scope hash between class
      // names ("stat est svelte-xyz"), so string matching misses flags
      est: [...el.querySelectorAll('.stat.est')].map((e) => flat(e.textContent)),
      inChips: el.querySelectorAll('.stat.in').length,
      bigBadges: el.querySelectorAll('.badge.tok.big').length,
    }));
    return rows;
  });
  const none = { text: '', html: '', head: '', think: [], blocks: [], tools: [], tokCount: -1, est: [], inChips: -1, bigBadges: -1 };
  const user = snap.find((r) => r.text.includes('qqq')) ?? none;
  const a1 = snap.find((r) => r.tools.some((t) => t.includes('search'))) ?? none;
  const a2 = snap.find((r) => r.tools.some((t) => t.includes('bash'))) ?? none;

  console.log('\nrows:', JSON.stringify({ user: user.head, a1: [a1.head, a1.think, a1.blocks], a2: [a2.head, a2.think, a2.blocks] }));

  // ---- 1) no per-message input chip anywhere -------------------------------
  check('no transcript chip uses the old .stat.in class', snap.every((r) => r.inChips === 0),
    `${snap.filter((r) => r.inChips !== 0).length} rows still carry one`);
  check('message heads carry no token numbers', [user, a1, a2].every((r) => !/\d+(\.\d+)?\s*(K|M)?\s*(in|tokens)\b/.test(r.head)),
    `${user.head} | ${a1.head} | ${a2.head}`);
  // ---- 2) user row: its own text, estimated -------------------------------
  check('user block shows its own estimated size ("≈61 tok")', user.blocks.includes('≈61 tok'),
    JSON.stringify(user.blocks));
  check('and is flagged as an estimate (dimmer .est, not a colour rule)',
    user.est.includes('≈61 tok'), JSON.stringify(user.est));
  check('user tip names the char count and the estimate',
    user.html.includes('estimated from 200 chars'), '');

  // ---- 3) thinking / reply each carry their own measured number -----------
  check('thinking summary shows the measured reasoning tokens ("513 tok")',
    a1.think.some((t) => t.includes('513 tok')), JSON.stringify(a1.think));
  check('its tip says reasoning, as reported for the step',
    a1.html.includes('513 reasoning tokens, as the engine reported them for this step'), '');
  check('reply text shows the measured output tokens ("487 tok")',
    a1.blocks.some((b) => b.startsWith('487 tok')), JSON.stringify(a1.blocks));
  check('and the step clock sits on its last generating block',
    a1.blocks.some((b) => b.includes('10.0s') && b.includes('100.00 t/s')), JSON.stringify(a1.blocks));
  check('the reasoning figure is NOT stamped on the reply block',
    !a1.blocks.some((b) => b.includes('513')), JSON.stringify(a1.blocks));

  // ---- 4) several blocks of one kind: measured total split by length ------
  check('two thinking blocks split the measured 1,000 by char share',
    a2.think.some((t) => /≈300 tok/.test(t)) && a2.think.some((t) => /≈700 tok/.test(t)),
    JSON.stringify(a2.think));
  check('both halves are flagged as estimates', a2.est.length === 2, JSON.stringify(a2.est));
  check('the tip states the split rule', a2.html.includes('split over its 2 thinking blocks by length'), '');
  check('a step with no completion time gets no clock chips',
    a2.blocks.every((b) => !b.includes('t/s')), JSON.stringify(a2.blocks));
  check('but its measured output still shows ("100 tok")',
    a2.blocks.some((b) => b.startsWith('100 tok')), JSON.stringify(a2.blocks));

  // ---- 5) tool rows keep their own injected-cost estimate -----------------
  check('big tool result carries its estimated cost ("≈236 tok")',
    a1.tools.some((t) => t.includes('≈236 tok')), a1.tools.join(' | ').slice(0, 200));
  check('tool tip gives chars + re-send warning',
    a1.html.includes('775 chars of output') && a1.html.includes('re-sends it'), '');
  check('exactly ONE cost chip in that row — the 40-char result is under the 30-tok floor',
    a1.tokCount === 1, `count=${a1.tokCount}`);
  check('8 KB result flags as a big dump ("≈2.4K tok")',
    a2.tools.some((t) => t.includes('≈2.4K tok')), a2.tools.join(' | ').slice(0, 200));
  check('one cost chip on the a2 row', a2.tokCount === 1, `count=${a2.tokCount}`);
  check('236 tok stays uncoloured, 2,440 tok turns to warn',
    a1.bigBadges === 0 && a2.bigBadges === 1, `a1 big=${a1.bigBadges}, a2 big=${a2.bigBadges}`);
  // the class alone proves nothing — check the colour actually differs
  const colors = await page.evaluate(() =>
    [...document.querySelectorAll('.badge.tok')].map((e) => getComputedStyle(e).color));
  check('warn colour really applies (computed color differs)',
    colors.length === 2 && colors[0] !== colors[1], colors.join(' vs '));

  // ---- InfoPanel: Prompt cost block (the measured split lives here now) ----
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
