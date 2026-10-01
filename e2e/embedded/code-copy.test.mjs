// code-copy.test.mjs — fence copy button in agent messages (md() wraps every
// ```fence in div.codeblock + button.code-copy; Transcript delegates the click
// and reads the text off the sibling <code>). Embedded fake engine serving
// webui/dist — no live engine/chatserver needed.
//
// Checks:
//   A. every fence renders a button, OUTSIDE the scrolling <pre>
//   B. click copies the exact fence text (hljs markup doesn't leak into it)
//   C. glyph flips to ✓ then back to 📋; oversized plaintext-fallback fences
//      get a button too
//   D. the message-level copy act still works (delegation didn't swallow it)
//   E. a model-authored <button> in message text is stripped by the sanitizer
//   F. language labels: "TypeScript" for the labeled fence, nothing at all for
//      the oversized fence (no detection ran → no honest label), and the label
//      is outside the <pre> so it never lands in the copied text
//
// Run: node e2e/embedded/code-copy.test.mjs

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, SHOTS_DIR, launchBrowser, sleep, poll, screenshot } from '../helpers/setup.mjs';

const PORT = Number(process.env.PORT) || 8171;
const BASE = `http://127.0.0.1:${PORT}`;
const SID = 'ses_codecopy1';
const T0 = Date.now() - 120_000;

const CODE = ['const greeting: string = "hi <there>"', 'console.log(greeting)'].join('\n');
// past FINAL_HIGHLIGHT_CAP_AT → plaintext fallback branch of renderer.code
const HUGE = 'x'.repeat(100_001);

const ANSWER = [
  'Two fences below.',
  '',
  '```ts',
  CODE,
  '```',
  '',
  'And an oversized one:',
  '',
  '```',
  HUGE,
  '```',
  '',
  'Done.',
].join('\n');

const EVIL = 'raw html attempt: <button class="evil">click me</button> and <b>bold</b>';

const MESSAGES = [
  {
    info: { id: 'msg_u1', role: 'user', agent: 'build', time: { created: T0 } },
    parts: [{ id: 'part_u1', type: 'text', text: 'show me some code' }],
  },
  {
    info: {
      id: 'msg_a1',
      role: 'assistant',
      agent: 'build',
      modelID: 'ox-alpha-free',
      providerID: 'opencode-go',
      time: { created: T0 + 1000 },
    },
    parts: [{ id: 'part_a1', type: 'text', text: ANSWER }],
  },
  {
    info: { id: 'msg_a2', role: 'assistant', agent: 'build', time: { created: T0 + 2000 } },
    parts: [{ id: 'part_a2', type: 'text', text: EVIL }],
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
};

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
  });
}
function json(res, obj, code = 200) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length });
  res.end(b);
}

const server = http.createServer(async (req, res) => {
  const p = req.url.split('?')[0];
  try {
    if (p === '/oc/event') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      return; // stays open
    }
    if (p === '/api/history/sessions')
      return json(res, [
        {
          id: SID,
          title: 'codecopy-probe',
          created: T0,
          updated: Date.now(),
          message_count: MESSAGES.length,
          cost: 0,
        },
      ]);
    if (p.endsWith('/errors')) {
      if (req.method === 'GET') return json(res, []);
      return json(res, { ok: true });
    }
    if (p.startsWith('/api/history/session/')) return json(res, MESSAGES);
    if (p === '/oc/session/status') return json(res, {});
    if (p.startsWith('/oc/session/') && p.endsWith('/message')) return json(res, MESSAGES);
    if (p.startsWith('/oc/session/')) return json(res, { id: SID, title: 'codecopy-probe', revert: null });
    if (p === '/oc/config/providers')
      return json(res, {
        providers: [{ id: 'opencode', models: { 'x-preview-f-free': { id: 'x-preview-f-free' } } }],
      });
    if (p === '/oc/path') return json(res, { directory: '/workspace' });
    if (p === '/oc/mcp') return json(res, {});
    if (p.startsWith('/oc/')) return json(res, []);

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
    try {
      json(res, { error: String(e) }, 500);
    } catch {
      /* headers already sent */
    }
  }
});

// ================================ checks ====================================

const results = [];
const pageErrors = [];
function check(c, name, pass, note = '') {
  results.push({ c, name, pass: !!pass, note });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${c} · ${name}${note ? ` — ${note}` : ''}`);
}
const copied = (page, i = 0) => page.evaluate((n) => window.__copied?.[n], i);

try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const browser = await launchBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  // capture clipboard writes instead of touching the real clipboard
  await ctx.addInitScript(() => {
    window.__copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (t) => (window.__copied.push(t), Promise.resolve()) },
    });
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));

  try {
    await page.goto(`${BASE}/?session=${SID}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const row = page.locator('#m-msg_a1');
    await row.waitFor({ timeout: 15000 });

    // ---- A. markup shape -----------------------------------------------------
    console.log('\nCASE A — one copy button per fence, outside the scrolling <pre>');
    check('A', 'two fences → two buttons', (await row.locator('.codeblock .code-copy').count()) === 2);
    check('A', 'buttons are <button type="button"> (keyboard reachable)', (await row.locator('.codeblock > button.code-copy[type="button"]').count()) === 2);
    check('A', 'no button nested inside <pre> (would scroll away)', (await row.locator('pre button').count()) === 0);
    check('A', 'wrapper is positioned (absolute anchor for the button)', (await row.locator('.codeblock').first().evaluate((el) => getComputedStyle(el).position)) === 'relative');
    await screenshot(page, 'codecopy-blocks');

    // ---- B. click copies the fence text --------------------------------------
    console.log('\nCASE B — click copies the exact source of that fence');
    await row.locator('.codeblock .code-copy').first().click();
    const got = await poll(async () => (await copied(page)) !== undefined);
    check('B', 'clipboard write happened', got);
    const text = (await copied(page)) ?? '';
    check('B', 'copied text === fence body (no hljs markup, no glyph)', text.replace(/\n$/, '') === CODE, JSON.stringify(text.slice(0, 80)));
    check('B', 'entities decoded (angle brackets are literal)', text.includes('hi <there>'));

    // ---- C. glyph feedback + plaintext-fallback fence ------------------------
    console.log('\nCASE C — ✓ flash, restore, and the oversized plaintext fence');
    check('C', 'glyph shows ✓ right after copy', (await row.locator('.codeblock .code-copy').first().innerText()).trim() === '✓');
    const restored = await poll(
      async () => (await row.locator('.codeblock .code-copy').first().innerText()).trim() === '📋',
      3000,
    );
    check('C', 'glyph restores to 📋 after ~1.2s', restored);
    const plain = row.locator('.codeblock').nth(1);
    check('C', 'oversized fence fell back to plaintext', (await plain.locator('code.language-plaintext').count()) === 1);
    await plain.locator('.code-copy').click();
    await poll(async () => (await copied(page, 1)) !== undefined);
    check('C', 'plaintext-fallback fence copies too', (await copied(page, 1)) === HUGE, `len=${((await copied(page, 1)) ?? '').length}`);

    // ---- D. the message-level copy act still works ---------------------------
    console.log('\nCASE D — header copy act unaffected by the delegated handler');
    await row.locator('.act[title="Copy message text"]').click();
    await poll(async () => (await copied(page, 2)) !== undefined);
    check('D', 'message act copies the full message text', (await copied(page, 2)) === ANSWER);

    // ---- E. sanitizer still drops model-authored buttons ---------------------
    console.log('\nCASE E — untrusted <button> in message text is removed');
    const evil = page.locator('#m-msg_a2');
    await evil.waitFor({ timeout: 10000 });
    check('E', 'model-authored button stripped', (await evil.locator('button.evil').count()) === 0);
    check('E', 'surrounding markup survives', (await evil.locator('b').count()) === 1);

    // ---- F. language labels --------------------------------------------------
    console.log('\nCASE F — language labels (pretty name, none for the un-detected fence)');
    const blocks = row.locator('.codeblock');
    // textContent = the canonical hljs name; rendered text is lowercased by CSS
    check('F', 'labeled fence shows hljs canonical name', (await blocks.nth(0).locator('.code-lang').textContent()) === 'TypeScript');
    check('F', 'label is visible', (await blocks.nth(0).locator('.code-lang').evaluate((el) => getComputedStyle(el).display)) === 'block');
    check('F', 'label sits outside the <pre>', (await row.locator('pre .code-lang').count()) === 0);
    check('F', 'oversized fence has NO label element at all', (await blocks.nth(1).locator('.code-lang').count()) === 0);
    check('F', 'its copy button still shows on hover', await blocks.nth(1).hover().then(async () => (await blocks.nth(1).locator('.code-copy').evaluate((el) => getComputedStyle(el).opacity)) === '1'));
    check('F', 'copy text unaffected by the label', (await copied(page, 0)).replace(/\n$/, '') === CODE);
    await row.locator('.codeblock').nth(1).screenshot({ path: path.join(SHOTS_DIR, 'codecopy-plain-nolabel.png') });
    await screenshot(page, 'codecopy-labels');
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
} finally {
  /* closed above */
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