import fs from 'node:fs';
import path from 'node:path';
import { E2E_DIR, launchBrowser, screenshot } from '../helpers/setup.mjs';

// Verifies image-read thumbnails + full-size lightbox (fully mocked payloads):
//  1. completed read of a real PNG → thumbnail <img> with data:image/png src
//  2. clicking the thumb opens the lightbox overlay (full-size img + caption)
//  3. Esc closes the lightbox
//  4. read of a MISSING image → no thumbnail rendered
//  5. read of a NON-image file → no thumbnail rendered

const SID = 'ses_imgthumb';
const PNG_PATH = '/workspace/shot.png';
const MISSING_IMG = '/workspace/gone.png';
const TXT_PATH = '/workspace/notes.md';

const PNG_B64 = fs.readFileSync(path.join(E2E_DIR, 'rename-dialog.png')).toString('base64');

const MSGS = [
  {
    info: { id: 'msg_u1', role: 'user', time: { created: 1000 } },
    parts: [{ id: 'p0', type: 'text', text: 'check the screenshot please' }],
  },
  {
    info: { id: 'msg_a1', role: 'assistant', time: { created: 2000 } },
    parts: [
      { id: 'p1', type: 'text', text: 'Looking at the image now.' },
      {
        id: 'p2',
        type: 'tool',
        tool: 'read',
        state: { status: 'completed', input: { filePath: PNG_PATH }, output: 'Image read successfully' },
      },
      {
        id: 'p3',
        type: 'tool',
        tool: 'read',
        state: { status: 'error', input: { filePath: MISSING_IMG }, error: 'File not found' },
      },
      {
        id: 'p4',
        type: 'tool',
        tool: 'read',
        state: {
          status: 'completed',
          input: { filePath: TXT_PATH },
          output: `<path>${TXT_PATH}</path>\n<content>\nhello\n</content>`,
          metadata: { preview: 'hello' },
        },
      },
    ],
  },
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
  if (m === 'GET' && p === '/oc/file/content') {
    const q = new URL(req.url()).searchParams.get('path') ?? '';
    // mirror engine shapes: raster → binary/base64, anything else → empty text
    if (q === PNG_PATH) return json({ type: 'binary', content: PNG_B64 });
    return json({ type: 'text', content: '' });
  }
  if (p === '/oc/session/status') return json({});
  if (p === '/oc/config/providers')
    return json({ providers: [{ id: 'opencode', models: { 'x-preview-f-free': { id: 'x-preview-f-free' } } }] });
  if (p === '/oc/command' || p === '/oc/permission' || p === '/oc/question' || p === '/oc/skill') return json([]);
  if (p === '/api/history/sessions')
    return json([{ id: SID, title: 'imgthumb render mock', created: 1, updated: 9, message_count: MSGS.length, cost: 0 }]);
  if (p === `/api/history/session/${SID}/errors`) return json([]);
  if (p === '/oc/event') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
  return route.fallback();
}
await page.route('**/oc/**', handle);
await page.route('**/api/**', handle);

let fail = 0;
const check = (ok, label) => {
  console.log(ok ? 'PASS' : 'FAIL', label);
  if (!ok) fail++;
};

try {
  await page.goto('http://127.0.0.1:8123/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  const item = page.locator('.sidebar button.item', { hasText: 'imgthumb render mock' }).first();
  await item.waitFor({ timeout: 15000 });
  await item.click();

  // 1. thumbnail appears with a decoded data URL
  const thumb = page.locator('#m-msg_a1 .toolcard .imgthumb img').first();
  await thumb.waitFor({ timeout: 8000 });
  const src = await thumb.getAttribute('src');
  check(src?.startsWith('data:image/png;base64,iVBOR') === true, `[1] thumbnail data:image/png src (${src?.slice(0, 40)}…)`);

  // 2. click opens the lightbox
  await thumb.click();
  const lbImg = page.locator('.overlay .frame img');
  await lbImg.waitFor({ timeout: 4000 });
  const lbSrc = await lbImg.getAttribute('src');
  const cap = await page.locator('.overlay .cap').innerText();
  check(lbSrc === src, '[2] lightbox shows same image full size');
  check(cap === PNG_PATH, `[3] caption is file path: ${cap}`);
  await screenshot(page, 'imgthumb-lightbox');

  // 3. Esc closes
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  check((await page.locator('.overlay').count()) === 0, '[4] Esc closes lightbox');

  // 4+5. no thumbs for missing image / non-image reads
  const cards = page.locator('#m-msg_a1 .toolcard');
  check(
    (await page.locator('#m-msg_a1 .imgthumb').count()) === 1,
    '[5] exactly one thumbnail in the message (missing/non-image reads render none)',
  );
  console.log('     toolcards:', await cards.count());

  await screenshot(page, 'imgthumb');
  console.log(fail ? `done ${fail} FAIL` : 'done ALL PASS');
  process.exitCode = fail ? 1 : 0;
} finally {
  await browser.close();
}
