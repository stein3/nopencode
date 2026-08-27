import path from 'node:path';
import { BASE, launchBrowser, SHOTS_DIR } from '../helpers/setup.mjs';

// Verifies, against fully mocked /oc + /api routes (no live model):
//  1. queueing while a turn is in flight — Enter AND the ➤ button must fire
//     additional POSTs even though the first POST never resolves
//  2. late POST failure with the message already in the transcript → box stays
//     empty (no blind restore)
//  3. late POST failure with the message NOT in the transcript → text restored

let sidCounter = 0;
let lastSid = null;
const posts = []; // {text}
let hangPosts = false; // first send hangs like a real blocking turn
let nextPostFails = false;
let transcriptTexts = []; // what GET .../message claims is landed

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

async function handle(route) {
  const req = route.request();
  const url = new URL(req.url());
  const p = url.pathname;
  const m = req.method();
  const json = (body) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

  if (m === 'POST' && /^\/oc\/session\/[^/]+\/message$/.test(p)) {
    const body = JSON.parse(req.postData() ?? '{}');
    const text = body?.parts?.[0]?.text ?? '';
    posts.push({ text });
    console.log(`[net] POST message #${posts.length}: "${String(text).slice(0, 40)}"`);
    if (hangPosts) return; // never resolve — simulates the blocking turn
    if (nextPostFails)
      return route.fulfill({ status: 504, contentType: 'application/json', body: '{"e":"gateway timeout"}' });
    return json({ id: 'msg_a' });
  }
  if (m === 'POST' && p === '/oc/session') {
    lastSid = 'fake-ses-' + ++sidCounter;
    return json({ id: lastSid, title: 't' });
  }
  if (m === 'GET' && /^\/oc\/session\/[^/]+\/message$/.test(p)) {
    return json(
      transcriptTexts.map((t, i) => ({
        info: { id: 'msg_u' + i, role: 'user', time: { created: 1000 + i } },
        parts: [{ id: 'p' + i, type: 'text', text: t }],
      })),
    );
  }
  if (p === '/oc/session/status')
    return json(lastSid && hangPosts ? { [lastSid]: { type: 'busy' } } : {});
  if (m === 'GET' && /^\/oc\/session\/[^/]+$/.test(p)) return json({ id: 'fake', title: 't', revert: null });
  if (p === '/oc/config/providers')
    return json({
      providers: [
        {
          id: 'opencode',
          models: Object.fromEntries(['x-preview-f-free'].map((id) => [id, { id }])),
        },
      ],
    });
  if (p === '/oc/command') return json([]);
  if (p === '/oc/permission') return json([]);
  if (p === '/oc/question') return json([]);
  if (p === '/api/history/sessions') return json([]);
  if (p === '/oc/event')
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
  return route.fallback();
}
await page.route('**/oc/**', handle);
await page.route('**/api/**', handle);

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.waitForTimeout(2000);
await page.keyboard.press('Control+t'); // fresh pending tab
await page.waitForTimeout(300);

const pane = page.locator('.tabpane[style*="flex"]');
const input = pane.locator('#composer-input');
const taValue = () => input.inputValue().catch(() => null);
const waitPosts = async (n, ms = 4000) => {
  for (let i = 0; i < ms / 100; i++) {
    if (posts.length >= n) return true;
    await page.waitForTimeout(100);
  }
  return false;
};

// ---- 1. send first message (hangs), then QUEUE via Enter -------------------
hangPosts = true;
await input.fill('first message');
await page.keyboard.press('Enter');
console.log('[1] first POST fired:', await waitPosts(1));
await page.waitForTimeout(500); // let sending flag release + UI settle
const stopVisible = await pane.locator('button.stop').isVisible().catch(() => false);
console.log('[1] busy spinner shown:', stopVisible);

await input.fill('second queued via enter');
const queueBtn = pane.locator('button.go.queued');
console.log('[1] queue button enabled:', await queueBtn.isEnabled());
await page.keyboard.press('Enter');
console.log('[1] Enter queued 2nd POST:', await waitPosts(2));
console.log('[1] box cleared after queue:', (await taValue()) === '');

// queue via button click too
await input.fill('third queued via button');
await page.waitForTimeout(200);
await queueBtn.click();
console.log('[1] click queued 3rd POST:', await waitPosts(3));

// no accidental extra sends
await page.waitForTimeout(600);
console.log('[1] no runaway sends (still 3):', posts.length === 3);

// ---- 2. failure but message DID land → must NOT restore --------------------
hangPosts = false;
nextPostFails = true;
transcriptTexts = ['first message', 'delivered-but-dropped']; // engine has it
await input.fill('delivered-but-dropped');
await page.keyboard.press('Enter');
await waitPosts(4);
await page.waitForTimeout(700); // failedSend does a GET before deciding
const errShown = await pane.locator('.composer .error').isVisible().catch(() => false);
console.log('[2] error banner shown:', errShown);
console.log('[2] NOT restored (box empty):', (await taValue()) === '');

// ---- 3. failure and message did NOT land → restore to box ------------------
transcriptTexts = []; // nothing landed
await input.fill('');
await input.fill('lost-in-flight');
await page.keyboard.press('Enter');
await waitPosts(5);
await page.waitForTimeout(700);
console.log('[3] restored to box:', (await taValue()) === 'lost-in-flight');

// restore must not clobber a newer draft
transcriptTexts = [];
await input.fill('');
await input.fill('another-lost');
await page.keyboard.press('Enter');
await waitPosts(6);
await page.waitForTimeout(100);
await input.fill('user typed new draft already');
await page.waitForTimeout(800);
console.log('[3b] newer draft preserved:', (await taValue()) === 'user typed new draft already');

await page.screenshot({ path: path.join(SHOTS_DIR, 'queue-fix-final.png'), fullPage: true });
await browser.close();
console.log('done');
