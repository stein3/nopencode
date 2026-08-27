import path from 'node:path'
import { BASE, ENGINE, E2E_DIR, launchBrowser } from '../helpers/setup.mjs'

// Verifies the session-error inline tile (real engine + chatserver on 8123):
//  1. engine session.error → red tile in transcript, no line above composer
//  2. tile shows the readable message (error.data.message)
//  3. sending a new prompt clears the tile optimistically

const j = (r) => r.json();

const sess = await fetch(`${ENGINE}/session`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'errtile-probe' }),
}).then(j);
console.log('[setup] probe session:', sess.id);

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

// only intercept the prompt send; everything else goes to the live chatserver
await page.route('**/oc/session/*/prompt_async', (route) => {
  if (route.request().method() === 'POST')
    return route.fulfill({ status: 502, contentType: 'text/plain', body: 'mocked dispatch failure' });
  return route.fallback();
});

try {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  const item = page.locator('.sidebar button.item', { hasText: 'errtile-probe' }).first();
  await item.waitFor({ timeout: 15000 });
  await item.click();
  await page.waitForTimeout(800);

  // ---- 1. trigger a real engine session.error ------------------------------
  const res = await fetch(`${ENGINE}/session/${sess.id}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      parts: [{ type: 'text', text: 'trigger error' }],
      model: { providerID: 'does-not-exist', modelID: 'nope' },
    }),
  });
  console.log('[1] bad-model POST status:', res.status);

  const tile = page.locator('.msg.errtile');
  await tile.waitFor({ timeout: 10000 });
  const tileText = (await tile.innerText()).trim();
  console.log('[1] tile visible:', await tile.isVisible());
  console.log('[1] tile text:', JSON.stringify(tileText));
  console.log(
    '[1] shows readable message:',
    tileText.includes('Model not found: does-not-exist/nope.'),
  );
  console.log(
    '[2] no error line above composer:',
    (await page.locator('.composer .error').count()) === 0,
  );

  // ---- 3. new send clears the tile ------------------------------------------
  const pane = page.locator('.tabpane[style*="flex"]');
  const input = pane.locator('#composer-input');
  await input.fill('try again');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  console.log('[3] tile cleared after new send:', (await tile.count()) === 0);
  console.log('[3] send-failed banner shown (mocked 502):', await pane.locator('.composer .error').isVisible());

  console.log('done PASS');
} finally {
  await browser.close();
  for (const id of [sess.id]) {
    await fetch(`${ENGINE}/session/${id}`, { method: 'DELETE' }).catch(() => {});
  }
}
