// Verify: EVERY tool card renders its output box, not just shell/grep-shaped
// tool names, and the box body is mounted lazily (only while expanded) so a
// 50 KB `read` result costs nothing in the DOM while collapsed.
//
// The engine-agnostic rule under test:
//   - non-empty state.output  -> collapsed box: preview line + line count
//   - running, no output yet  -> '…'
//   - completed, empty output -> '(no output)'
//   - shell-shaped tool names still preview the LAST line (8cb0896)
//
// Runs against an EMBEDDED fake engine (same pattern as grep-count.test.mjs):
// in-process HTTP server serving webui/dist + stubbed /oc endpoints.
//
// Run: node e2e/embedded/tool-output-box.test.mjs

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, launchBrowser, SHOTS_DIR } from '../helpers/setup.mjs';

const PORT = 8178;
const BASE = `http://127.0.0.1:${PORT}`;
const SID = 'ses_tooloutput1';
const MSG_ID = 'msg_tooloutput';
const TITLE = 'Tool output box on every tool';

// Neutral tool names on purpose: none of them match the old shell/grep name
// patterns (/bash|shell|cmd/, /grep|find|search/), so a regression that puts
// the name gate back makes this test fail rather than accidentally pass.
const NOTEPAD_OUT = 'line one is the finding\nline two\nline three\nline four';
const BASH_OUT = 'npm notice run test\n\n> vitest run\n\n22 passed (22)';
const GREP_OUT = 'Found 3 matches\n  Line 12: foo\n  Line 45: bar\n  Line 78: baz';

const MESSAGES = [
  {
    info: {
      id: MSG_ID,
      role: 'assistant',
      agent: 'build',
      modelID: 'x-preview-f-free',
      providerID: 'opencode',
      time: { created: Date.now() - 60_000 },
    },
    parts: [
      {
        id: 'part_notepad',
        type: 'tool',
        tool: 'notepad',
        state: {
          status: 'completed',
          input: { query: 'release notes' },
          output: NOTEPAD_OUT,
        },
      },
      {
        id: 'part_calculator',
        type: 'tool',
        tool: 'calculator',
        state: { status: 'completed', input: { expr: '1+1' }, output: '' },
      },
      {
        id: 'part_palette',
        type: 'tool',
        tool: 'palette',
        state: { status: 'running', input: { name: 'ember' }, output: '' },
      },
      {
        id: 'part_bash1',
        type: 'tool',
        tool: 'bash',
        state: { status: 'completed', input: { command: 'npm test' }, output: BASH_OUT },
      },
      {
        // the one tool-specific nicety left in the box: grep's match tally.
        // It moved INSIDE the lazy body, so it needs asserting here.
        id: 'part_grep1',
        type: 'tool',
        tool: 'grep',
        state: {
          status: 'completed',
          input: { pattern: 'foo', path: '/workspace' },
          output: GREP_OUT,
        },
      },
    ],
  },
];

const SESSIONS = [
  { id: SID, title: TITLE, created: Date.now() - 120_000, updated: Date.now() - 30_000, message_count: 1, cost: 0 },
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
    if (p === '/oc/event') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      req.on('close', () => {});
      return;
    }
    if (p === '/api/history/sessions') return json(res, SESSIONS);
    if (p.endsWith('/errors')) return req.method === 'GET' ? json(res, []) : json(res, { ok: true });
    if (p.startsWith('/api/history/session/')) return json(res, []);
    if (p === '/oc/session/status') return json(res, {});
    if (p.startsWith('/oc/session/') && p.endsWith('/message')) return json(res, MESSAGES);
    if (p.startsWith('/oc/session/')) return json(res, { id: SID, title: TITLE, revert: null });
    if (p === '/oc/session' && req.method === 'POST') return json(res, { id: SID, title: TITLE, revert: null });
    if (p === '/oc/config/providers')
      return json(res, { providers: [{ id: 'opencode', models: { 'x-preview-f-free': { id: 'x-preview-f-free' } } }] });
    if (p === '/oc/path') return json(res, { directory: '/workspace' });
    if (p === '/oc/mcp') return json(res, {});
    if (p.startsWith('/oc/')) return json(res, []);

    // webui/dist is built with base '/webui/' (what pi-web's serveStatic and
    // chatserver.py expect), so a root-served fake must strip that prefix —
    // otherwise every asset 404s and the app never mounts (looks like a bug).
    const rel = p === '/' ? '/index.html' : p.startsWith('/webui/') ? p.slice('/webui'.length) : p;
    const full = fs.realpathSync(path.join(DIST, rel));
    if (!full.startsWith(fs.realpathSync(DIST)) || !fs.statSync(full).isFile())
      return json(res, { error: 'missing' }, 404);
    const b = fs.readFileSync(full);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] ?? 'application/octet-stream', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
    res.end(b);
  } catch (e) {
    try { json(res, { error: String(e) }, 500); } catch { /* headers sent (SSE) */ }
  }
});

const results = [];
const pageErrors = [];
function check(name, pass, note = '') {
  results.push({ name, pass: !!pass, note });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${note ? ` — ${note}` : ''}`);
}

const PANE = '.tabpane[style*="flex"]';

// A missing locator is a FAILED check, not a crash: wait for it, then read.
// Without the wait these reads race the history render and a check can miss a
// node that is there 5 ms later — a flake that later "proves" nothing.
async function txt(locator) {
  try {
    await locator.waitFor({ state: 'attached', timeout: 5000 })
  } catch {
    return ''
  }
  return (await locator.textContent()) ?? ''
}

try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1900 } });
  page.on('pageerror', (e) => pageErrors.push(e.message));

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForSelector('.sidebar .item', { timeout: 15000 });
    const row = page.locator(`.sidebar .item[title="${TITLE}"]`);
    if (!(await row.count())) throw new Error('fixture session not found in sidebar');
    await row.click();
    try {
      await page.waitForSelector(`${PANE} .toolcard`, { timeout: 8000 });
    } catch {
      const tb = page.locator(`.tabbar .tab[title="${TITLE}"]`);
      if (!(await tb.count())) throw new Error('fixture tab not found in tab bar');
      await tb.click();
    }
    await page.waitForSelector(`${PANE} .toolcard`, { timeout: 15000 });

    // name -> the card whose summary shows that tool name
    const cards = page.locator(`${PANE} .toolcard`);
    const n = await cards.count();
    const cardOf = async (name) => {
      for (let i = 0; i < n; i++) {
        const t = ((await cards.nth(i).locator('summary .tname').textContent()) ?? '').trim();
        if (t.toLowerCase() === name) return cards.nth(i);
      }
      return null;
    };

    // `.outbox` not `details.outbox`: the empty/pending box is a div (nothing to
    // expand), every tool row still gets one
    const withBox = await page.locator(`${PANE} .toolcard .outbox`).count();
    check('every tool card has an output box', withBox === n, `boxes=${withBox} cards=${n}`);

    // ---- preview line rules (collapsed summary) ----------------------------
    const notepad = await cardOf('notepad');
    if (!notepad) throw new Error('no notepad tool card found');
    const preview = (await txt(notepad.locator('details.outbox summary .outline'))).trim();
    check('non-shell row previews the FIRST line', preview === 'line one is the finding', `got "${preview}"`);
    const count = (await txt(notepad.locator('details.outbox summary .ocount'))).trim();
    check('line count advertised', count === '4 lines', `got "${count}"`);

    const bash = await cardOf('bash');
    const bashPreview = (await txt(bash?.locator('details.outbox summary .outline'))).trim();
    check('shell row still previews the LAST line', bashPreview === '22 passed (22)', `got "${bashPreview}"`);

    // ---- lazy body: nothing rendered while collapsed -----------------------
    // Asserted on the BASH card: that row had an output box before the change
    // too, so it proves the body is lazily mounted rather than just absent.
    const bashPreClosed = await bash.locator('details.outbox pre.out').count();
    check('collapsed box mounts no body', bashPreClosed === 0, `pre.out while closed=${bashPreClosed}`);

    const closedPre = await notepad.locator('details.outbox pre.out').count();
    check('non-shell collapsed box mounts no body', closedPre === 0, `pre.out while closed=${closedPre}`);

    const notepadSummary = notepad.locator('details.outbox summary');
    if (await notepadSummary.count()) {
      await notepadSummary.click();
      await page.waitForTimeout(150);
    }
    const openPre = (await txt(notepad.locator('details.outbox pre.out'))) ?? '';
    check('expanded box renders the FULL output verbatim', openPre === NOTEPAD_OUT, `got ${openPre.length} chars`);

    // collapse again: the body must unmount (that is what keeps a 50 KB read cheap)
    if (await notepadSummary.count()) {
      await notepadSummary.click();
      await page.waitForTimeout(150);
    }
    const reclosedPre = await notepad.locator('details.outbox pre.out').count();
    check('collapsing unmounts the body', reclosedPre === 0, `pre.out after collapse=${reclosedPre}`);

    // expand the bash box and check its full text + no stray caret state
    const bashSummary = bash.locator('details.outbox summary');
    if (await bashSummary.count()) {
      await bashSummary.click();
      await page.waitForTimeout(150);
    }
    const bashOpen = (await txt(bash.locator('details.outbox pre.out'))) ?? '';
    check('shell box still renders full output', bashOpen === BASH_OUT, `got ${bashOpen.length} chars`);

    // ---- grep match tally still renders inside the lazy body ---------------
    const grepCard = await cardOf('grep');
    const grepSummary = grepCard?.locator('details.outbox summary');
    if (await grepSummary?.count()) {
      await grepSummary.click();
      await page.waitForTimeout(150);
    }
    const grepOut = (await txt(grepCard?.locator('details.outbox pre.out'))) ?? '';
    check('grep box renders its output', grepOut === GREP_OUT, `got ${grepOut.length} chars`);
    const tally = (await txt(grepCard?.locator('.matchcount'))).trim();
    check('grep tally footer renders when expanded', tally === '(3 matches)', `got "${tally}"`);

    // ---- placeholders ------------------------------------------------------
    const calc = await cardOf('calculator');
    const calcText = (await txt(calc?.locator('.outbox pre.out'))).trim();
    check('completed tool with empty output says (no output)', calcText === '(no output)', `got "${calcText}"`);

    const pal = await cardOf('palette');
    const palText = (await txt(pal?.locator('.outbox pre.out'))).trim();
    check('running tool shows the pending ellipsis', palText === '…', `got "${palText}"`);

    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    await page.screenshot({ path: `${SHOTS_DIR}/tool-output-box-full.png` });
  } finally {
    await browser.close();
  }
} finally {
  await new Promise((r) => server.close(r));
}

console.log('\n================ SUMMARY ================');
let fails = 0;
for (const r of results) {
  console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.note ? ` — ${r.note}` : ''}`);
  if (!r.pass) fails++;
}
if (pageErrors.length) {
  console.log(`\npage errors observed (${pageErrors.length}):`);
  for (const e of [...new Set(pageErrors)].slice(0, 5)) console.log('  •', e.slice(0, 220));
}
console.log('\nChecks:', results.length, '| failed:', fails);
process.exitCode = fails ? 1 : 0;
