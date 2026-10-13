// user-md.test.mjs — heading suppression for the user's own messages (md() 3rd
// arg; Transcript passes headings=false for role==='user'). Embedded fake
// engine serving webui/dist — no live engine/chatserver needed.
//
// Checks:
//   A. user message: `# ...` renders literally (no <h1>), rest of the line
//      keeps flowing — pasted console comments are not banners
//   B. user message: intentional markdown still renders (lists + inline code)
//   C. user message: a ``` fence keeps byte fidelity for its `# comment`
//      (no literal backslash — a naive pre-pass escape would corrupt this)
//   D. user message: setext banner (`foo` / `---`) renders literally — no
//      <h2>, no <hr>
//   E. assistant message: headings render normally (scope is role=user only)
//
// Run: node e2e/embedded/user-md.test.mjs

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, SHOTS_DIR, launchBrowser, screenshot } from '../helpers/setup.mjs';

const PORT = Number(process.env.PORT) || 8172;
const BASE = `http://127.0.0.1:${PORT}`;
const SID = 'ses_usermd1';
const T0 = Date.now() - 120_000;

const PASTE_HASH = ['# shell comment', '$ ls -la'].join('\n');
const USER_MD = ['- one', '- two', '', 'use `inline` code'].join('\n');
const USER_FENCE = ['```sh', '# comment in fence', '```'].join('\n');
const USER_SETEXT = ['foo', '---'].join('\n');
const AGENT = ['# Agent banner', '', '## Section', '', 'plain text'].join('\n');

const um = (id, text, t) => ({
  info: { id, role: 'user', agent: 'build', time: { created: T0 + t } },
  parts: [{ id: `part_${id}`, type: 'text', text }],
});

const MESSAGES = [
  um('msg_u1', PASTE_HASH, 0),
  um('msg_u2', USER_MD, 1000),
  um('msg_u3', USER_FENCE, 2000),
  um('msg_u4', USER_SETEXT, 3000),
  {
    info: {
      id: 'msg_a1',
      role: 'assistant',
      agent: 'build',
      modelID: 'ox-alpha-free',
      providerID: 'opencode-go',
      time: { created: T0 + 4000 },
    },
    parts: [{ id: 'part_a1', type: 'text', text: AGENT }],
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
        { id: SID, title: 'user-md-probe', created: T0, updated: Date.now(), message_count: MESSAGES.length, cost: 0 },
      ]);
    if (p.endsWith('/errors')) {
      if (req.method === 'GET') return json(res, []);
      return json(res, { ok: true });
    }
    if (p.startsWith('/api/history/session/')) return json(res, MESSAGES);
    if (p === '/oc/session/status') return json(res, {});
    if (p.startsWith('/oc/session/') && p.endsWith('/message')) return json(res, MESSAGES);
    if (p.startsWith('/oc/session/')) return json(res, { id: SID, title: 'user-md-probe', revert: null });
    if (p === '/oc/config/providers')
      return json(res, { providers: [{ id: 'opencode', models: { 'x-preview-f-free': { id: 'x-preview-f-free' } } }] });
    if (p === '/oc/path') return json(res, { directory: '/workspace' });
    if (p === '/oc/mcp') return json(res, {});
    if (p.startsWith('/oc/')) return json(res, []);

    const rel = p === '/' ? '/index.html' : p;
    const full = fs.realpathSync(path.join(DIST, rel));
    if (!full.startsWith(fs.realpathSync(DIST)) || !fs.statSync(full).isFile()) return json(res, { error: 'missing' }, 404);
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
  results.push({ name, pass: !!pass, note });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${c} · ${name}${note ? ` — ${note}` : ''}`);
}
const row = (page, id) => page.locator(`#m-${id}`);
const count = (loc, sel) => loc.locator(sel).count();

try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const browser = await launchBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));

  try {
    await page.goto(`${BASE}/?session=${SID}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await row(page, 'msg_a1').waitFor({ timeout: 15000 });

    // ---- A. user `#` line renders literally --------------------------------
    console.log('\nCASE A — user paste: `# comment` is text, not a banner');
    const u1 = row(page, 'msg_u1');
    check('A', 'no heading elements in the user row', (await count(u1, 'h1,h2,h3,h4,h5,h6')) === 0);
    const u1t = await u1.locator('.body').innerText();
    check('A', 'hash line kept literally', u1t.includes('# shell comment'), JSON.stringify(u1t.slice(0, 60)));
    check('A', 'rest of the paste keeps flowing', u1t.includes('$ ls -la'));

    // ---- B. intentional user markdown still renders -------------------------
    console.log('\nCASE B — user lists + inline code still markdown');
    const u2 = row(page, 'msg_u2');
    check('B', 'list renders as ul>li', (await count(u2, 'ul > li')) === 2);
    check('B', 'inline code renders', (await u2.locator('p code').first().innerText()) === 'inline');

    // ---- C. fence byte fidelity ---------------------------------------------
    console.log('\nCASE C — user fence keeps `# comment` byte-exact');
    const u3 = row(page, 'msg_u3');
    const code = (await u3.locator('pre code').first().innerText()).replace(/\n$/, '');
    check('C', 'fence body has no escaped backslash', code === '# comment in fence', JSON.stringify(code));

    // ---- D. setext banner literal -------------------------------------------
    console.log('\nCASE D — user `foo`/`---` setext renders literally');
    const u4 = row(page, 'msg_u4');
    check('D', 'no h1/h2/hr from the setext pair', (await count(u4, 'h1,h2,hr')) === 0);
    const u4t = await u4.locator('.body').innerText();
    check('D', 'both lines kept literally', u4t.includes('foo') && u4t.includes('---'), JSON.stringify(u4t));
    await screenshot(page, 'user-md');

    // ---- E. agent headings untouched ----------------------------------------
    console.log('\nCASE E — assistant headings still render');
    const a1 = row(page, 'msg_a1');
    check('E', 'h1 renders', (await a1.locator('h1').innerText()) === 'Agent banner');
    check('E', 'h2 renders', (await a1.locator('h2').innerText()) === 'Section');
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
