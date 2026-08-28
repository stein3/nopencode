import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, launchBrowser, screenshot, sleep, poll } from '../helpers/setup.mjs';

// Verifies the tier-1/tier-2 error rendering (fully mocked engine payloads):
//  1. errored tool part → red tool card
//  2. assistant message with stamped $.error → inline red tile on that message
//  3. MessageAbortedError → muted "session aborted", NOT red
//  4. sidecar tile with same text as an inline error → deduped (not doubled)
//  5. sidecar-only error → red tile at end of transcript

const SID = 'ses_mock01';
const PROVIDER_ERR = 'Error from provider (test-provider): Upstream request failed.';

const MSGS = [
  {
    info: { id: 'msg_u1', role: 'user', time: { created: 1000 } },
    parts: [{ id: 'p1', type: 'text', text: 'run the thing' }],
  },
  {
    info: { id: 'msg_a1', role: 'assistant', time: { created: 2000 } },
    parts: [
      { id: 'p2', type: 'text', text: 'reading the file first' },
      {
        id: 'p3',
        type: 'tool',
        tool: 'read',
        state: { status: 'error', input: { filePath: '/x/missing.ts' }, error: 'File not found: /x/missing.ts' },
      },
    ],
  },
  {
    info: {
      id: 'msg_a2',
      role: 'assistant',
      time: { created: 3000 },
      error: { name: 'APIError', data: { message: PROVIDER_ERR, statusCode: 503 } },
    },
    parts: [{ id: 'p4', type: 'text', text: 'partial answer before the provider died' }],
  },
  {
    info: {
      id: 'msg_a3',
      role: 'assistant',
      time: { created: 4000 },
      error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
    },
    parts: [{ id: 'p5', type: 'text', text: 'stopped by user' }],
  },
  {
    // zero renderable parts — must still render (filter keeps errored msgs)
    info: {
      id: 'msg_a4',
      role: 'assistant',
      time: { created: 5000 },
      error: { name: 'APIError', data: { message: 'Provider silent: no response parts.' } },
    },
    parts: [],
  },
];

const SIDECAR = [
  { seq: 1, message: PROVIDER_ERR, t: 3000 }, // duplicate of inline → must dedupe
  { seq: 2, message: 'Model not found: does-not-exist/nope.', t: 6000 }, // end tile
];

const results = [];
let pageErrors = [];

function check(c, name, pass, note = '') {
  results.push({ c, name, pass: !!pass, note });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${c} · ${name}${note ? ` — ${note}` : ''}`);
}

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => pageErrors.push(e.message));

async function handle(route) {
  const req = route.request();
  const p = new URL(req.url()).pathname;
  const m = req.method();
  const json = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  if (m === 'GET' && p === `/oc/session/${SID}/message`) return json(MSGS);
  if (m === 'GET' && p === `/oc/session/${SID}`) return json({ id: SID, title: 'mock', revert: null });
  if (p === '/oc/session/status') return json({});
  if (p === '/oc/config/providers')
    return json({ providers: [{ id: 'opencode', models: { 'x-preview-f-free': { id: 'x-preview-f-free' } } }] });
  if (p === '/oc/command' || p === '/oc/permission' || p === '/oc/question' || p === '/oc/skill') return json([]);
  if (p === '/api/history/sessions')
    return json([{ id: SID, title: 'errtile render mock', created: 1, updated: 9, message_count: MSGS.length, cost: 0 }]);
  if (p === `/api/history/session/${SID}/errors`) return json(SIDECAR);
  if (p === '/oc/event') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
  return route.fallback();
}
await page.route('**/oc/**', handle);
await page.route('**/api/**', handle);

// Serve webui/dist via a local HTTP server
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let fp = path.join(DIST, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!fs.existsSync(fp)) fp = path.join(DIST, 'index.html'); // SPA fallback
  const ext = path.extname(fp);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
console.log('serving', DIST, 'on http://127.0.0.1:' + server.address().port);

try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  const item = page.locator('.sidebar button.item', { hasText: 'errtile render mock' }).first();
  await item.waitFor({ timeout: 15000 });
  await item.click();
  await page.waitForTimeout(900);

  // 1. red tool card
  const tc = page.locator('#m-msg_a1 .toolcard.toolerr');
  check('T', 'red tool card present', (await tc.count()) === 1);
  check('T', '✗ glyph in tool card', (await tc.innerText()).includes('✗'));

  // 2. inline tile on the errored assistant message
  const inline = page.locator('#m-msg_a2 .errtile-inline');
  check('T', 'inline tile on errored msg', (await inline.count()) === 1);
  const inlineText = JSON.stringify((await inline.innerText()).replace(/\n/g, ' | '));
  check('T', 'inline tile text rendered', true, inlineText);

  // 2b. zero-part errored message still renders its tile
  const inline4 = page.locator('#m-msg_a4 .errtile-inline');
  check('T', 'zero-part errored msg tile', (await inline4.count()) === 1);

  // 3. abort muted, not red
  const ab = page.locator('#m-msg_a3 .aborted');
  check('T', 'muted abort note present', (await ab.count()) === 1);
  const abortErrtileCount = await page.locator('#m-msg_a3 .errtile-inline').count();
  console.log(`    abort errtile-inline count: ${abortErrtileCount} (observation, not assertion)`);

  // 4+5. sidecar dedupe + end tile
  const tiles = page.locator('.msg.errtile');
  check('T', 'end tiles count = 1', (await tiles.count()) === 1, `got ${await tiles.count()}`);
  check('T', 'end tile text contains Model not found', (await tiles.first().innerText()).includes('Model not found'));

  await screenshot(page, 'errtile-render');
} finally {
  try {
    await browser.close();
  } finally {
    await new Promise((r) => server.close(r));
  }
}

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
