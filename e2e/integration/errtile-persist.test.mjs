import { BASE, ENGINE, launchBrowser, screenshot, cleanup } from '../helpers/setup.mjs'

// Verifies persisted session-error tiles (real engine + chatserver on 8123):
//  1. engine session.error → red tile, readable message, nothing above composer
//  2. reload + reopen → tile still there (sidecar webui.db)
//  3. new send does NOT clear the tile (tiles are history) — locally or after reload

const j = (r) => r.json();

const sess = await fetch(`${ENGINE}/session`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'errtile-probe-persist' }),
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

const openProbe = async () => {
  const item = page.locator('.sidebar button.item', { hasText: 'errtile-probe-persist' }).first();
  await item.waitFor({ timeout: 15000 });
  await item.click();
  await page.waitForTimeout(700);
};

try {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(1500);
  await openProbe();

  // ---- 1. trigger a real engine session.error ------------------------------
  await fetch(`${ENGINE}/session/${sess.id}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      parts: [{ type: 'text', text: 'trigger error' }],
      model: { providerID: 'does-not-exist', modelID: 'nope' },
    }),
  });
  const tile = page.locator('.msg.errtile');
  await tile.waitFor({ timeout: 10000 });
  console.log('[1] live tile:', JSON.stringify((await tile.innerText()).trim()));
  console.log('[1] no composer error line:', (await page.locator('.composer .error').count()) === 0);

  // ---- 2. reload → tile persists -------------------------------------------
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await openProbe();
  await tile.waitFor({ timeout: 8000 });
  console.log('[2] tile after reload:', JSON.stringify((await tile.innerText()).trim()));

  // ---- 3. resend does NOT clear the tile ------------------------------------
  const pane = page.locator('.tabpane[style*="flex"]');
  const input = pane.locator('#composer-input');
  await input.fill('try again');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800); // let any (removed) clear path land
  console.log('[3] tile survives send:', (await tile.count()) === 1);
  console.log('[3] send-failed banner (mocked 502):', await pane.locator('.composer .error').isVisible());

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await openProbe();
  await tile.waitFor({ timeout: 8000 });
  console.log('[3] still there after reload:', (await tile.count()) === 1);

  await screenshot(page, 'errtile-persist');
  console.log('done PASS');
} finally {
  await browser.close();
  await cleanup([sess.id]);
  await fetch(`${BASE}/api/history/session/${sess.id}/errors`, { method: 'DELETE' }).catch(() => {});
}
