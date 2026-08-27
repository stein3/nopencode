import { launchBrowser, screenshot } from '../helpers/setup.mjs';

// Verifies the tier-1/tier-2 error rendering (fully mocked engine payloads):
//  1. errored tool part → red tool card
//  2. assistant message with stamped $.error → inline red tile on that message
//  3. MessageAbortedError → muted "session aborted", NOT red
//  4. sidecar tile with same text as an inline error → deduped (not doubled)
//  5. sidecar-only error → red tile at end of transcript

const SID = 'ses_mock01';
const PROVIDER_ERR = 'Error from provider (Console Go): Upstream request failed.';

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

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

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

try {
  await page.goto('http://127.0.0.1:8123/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  const item = page.locator('.sidebar button.item', { hasText: 'errtile render mock' }).first();
  await item.waitFor({ timeout: 15000 });
  await item.click();
  await page.waitForTimeout(900);

  // 1. red tool card
  const tc = page.locator('#m-msg_a1 .toolcard.toolerr');
  console.log('[1] red tool card:', (await tc.count()) === 1, '| ✗ glyph:', (await tc.innerText()).includes('✗'));

  // 2. inline tile on the errored assistant message
  const inline = page.locator('#m-msg_a2 .errtile-inline');
  console.log('[2] inline tile on msg_a2:', (await inline.count()) === 1);
  console.log('    text:', JSON.stringify((await inline.innerText()).replace(/\n/g, ' | ')));

  // 2b. zero-part errored message still renders its tile
  const inline4 = page.locator('#m-msg_a4 .errtile-inline');
  console.log('[2b] zero-part errored msg tile:', (await inline4.count()) === 1);

  // 3. abort muted, not red
  const ab = page.locator('#m-msg_a3 .aborted');
  console.log('[3] muted abort note:', (await ab.count()) === 1, '| red tile on abort:', (await page.locator('#m-msg_a3 .errtile-inline').count()) === 1);

  // 4+5. sidecar dedupe + end tile
  const tiles = page.locator('.msg.errtile');
  console.log('[4] end tiles count (want 1):', await tiles.count());
  console.log('[5] end tile is Model-not-found:', (await tiles.first().innerText()).includes('Model not found'));

  await screenshot(page, 'errtile-render');
  console.log('done PASS');
} finally {
  await browser.close();
}
