import { BASE, launchBrowser, screenshot } from '../helpers/setup.mjs'

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

// capture every prompt POST
let sentBodies = [];
await page.route('**/oc/session/*/message', async (route) => {
  if (route.request().method() !== 'POST') return route.fallback();
  const body = route.request().postDataJSON();
  sentBodies.push(body);
  const sid = route.request().url().split('/session/')[1].split('/')[0];
  void sid;
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      info: {
        id: 'msg_probe' + sentBodies.length, role: 'user', sessionID: sid,
        time: { created: Date.now() }, agent: 'build',
        model: body?.model ? { providerID: body.model.providerID, modelID: body.model.modelID } : undefined,
      },
      parts: [{ id: 'prt_probe' + sentBodies.length, type: 'text', text: body?.parts?.[0]?.text ?? '' }],
    }),
  });
});

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.waitForTimeout(2500);

// ---- phase 1: new chat — dropdown below header drives the first prompt ----
await page.keyboard.press('Control+t');
await page.locator('.empty select').waitFor({ timeout: 5000 });
console.log('[1] dropdown visible on new-session page');
await page.selectOption('.empty select', 'opencode/x-preview-f-free');
await page.waitForTimeout(300);
console.log('[1] picked:', await page.inputValue('.empty select'),
  '| localStorage:', await page.evaluate(() => localStorage.getItem('opencode.model')));
await page.fill('#composer-input:visible', 'probe one');
await page.keyboard.press('Enter');
await page.waitForTimeout(1800);
console.log('[1] prompt #1 model:', JSON.stringify(sentBodies[0]?.model));

// ---- phase 2: same tab now non-empty → use the TOPBAR picker to switch ----
await page.click('button[title="Select model"]');
await page.locator('.topbar .menu').waitFor({ timeout: 3000 });
await page.click('.topbar .menu button.m:has-text("Big Pickle")');
await page.waitForTimeout(500);
console.log('[2] localStorage after topbar pick:', await page.evaluate(() => localStorage.getItem('opencode.model')));
await page.fill('#composer-input:visible', 'probe two');
await page.keyboard.press('Enter');
await page.waitForTimeout(1800);
console.log('[2] prompt #2 model:', JSON.stringify(sentBodies[1]?.model));
console.log('[2] model CHANGED between prompts:', sentBodies[0]?.model?.modelID !== sentBodies[1]?.model?.modelID);

await screenshot(page, 'verify-final');

// cleanup probe sessions created during the test via the engine directly
const sids = [...new Set(sentBodies.map((b) => null).filter(Boolean))];
console.log('done; prompts captured:', sentBodies.length);
await browser.close();
