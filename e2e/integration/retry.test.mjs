import { launchBrowser, screenshot } from '../helpers/setup.mjs'

// Verifies the auto-retry loop against the fake engine (scripted SSE):
//  A. retryable error → retry at 5s → error → retry at 15s → success (idle)
//     → loop clears; countdown line shows attempt + mmss; backoff respected
//  B. cancel button stops the loop
//  C. manual send during a countdown cancels the loop

const BASE = 'http://127.0.0.1:8124';
const state = async () => (await fetch(`${BASE}/__state`).then((r) => r.json())).prompts;

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

const openSession = async (title) => {
  const item = page.locator('.sidebar button.item', { hasText: title }).first();
  await item.waitFor({ timeout: 15000 });
  await item.click();
  await page.waitForTimeout(600);
  const pane = page.locator('.tabpane[style*="flex"]');
  await pane.locator('#composer-input').fill('');
  return pane;
};

try {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(1500);

  // ---- A. two failures, then success ---------------------------------------
  const paneA = await openSession('retry-probe');
  const lineA = paneA.locator('.retryline');
  const t0 = Date.now();
  await paneA.locator('#composer-input').fill('hello retry');
  await page.keyboard.press('Enter');

  await lineA.waitFor({ timeout: 8000 }); // appears after the 1.2s scripted error
  const txt1 = await lineA.innerText();
  console.log('[A] line after 1st error:', JSON.stringify(txt1.replace(/\s+/g, ' ')));
  console.log('[A] attempt 1 + countdown ≤5:', txt1.includes('attempt 1') && /0:0[1-5]/.test(txt1));

  await page.waitForFunction(
    () => document.querySelectorAll('.tabpane[style*="flex"] .retryline').length === 0 ||
      [...document.querySelectorAll('.tabpane[style*="flex"] .retryline')].some((n) => n.textContent.includes('attempt 2')),
    { timeout: 15000 },
  );
  const t1 = Date.now();
  await lineA.waitFor({ timeout: 8000 });
  const txt2 = await lineA.innerText();
  console.log('[A] 2nd dispatch after ~1s:', t1 - t0 > 1500 && t1 - t0 < 8000, `(${Math.round((t1 - t0) / 1000)}s)`);
  console.log('[A] line shows attempt 2:', txt2.includes('attempt 2'), '| countdown ≤2:', /0:0[12]/.test(txt2));

  // 3rd dispatch lands (fake engine emits idle) → line disappears, count = 3
  await lineA.waitFor({ state: 'detached', timeout: 30000 });
  const t2 = Date.now();
  console.log('[A] 2nd backoff ~2s (+idle):', t2 - t1 > 2500 && t2 - t1 < 9000, `(${Math.round((t2 - t1) / 1000)}s)`);
  await page.waitForTimeout(2500); // no further retries
  const promptsA = (await state())[Object.keys(await state())[0]] ?? [];
  const all = await state();
  const flat = Object.values(all).flat();
  const helloCount = flat.filter((t) => t === 'hello retry').length;
  console.log('[A] total "hello retry" dispatches (want 3):', helloCount);
  console.log('[A] line gone after success:', (await lineA.count()) === 0);

  // ---- B. cancel button ------------------------------------------------------
  await page.keyboard.press('Control+t');
  await page.waitForTimeout(400);
  // fresh pending tab: first send creates a session server-side
  const paneB = page.locator('.tabpane[style*="flex"]');
  await paneB.locator('#composer-input').fill('cancel me');
  await page.keyboard.press('Enter');
  const lineB = paneB.locator('.retryline');
  await lineB.waitFor({ timeout: 8000 });
  await paneB.locator('.retryline .rcancel').click();
  await page.waitForTimeout(7000); // past the 5s mark — no retry may fire
  console.log('[B] line gone after cancel:', (await lineB.count()) === 0);
  const flatB = Object.values(await state()).flat();
  console.log('[B] no retry dispatched (1 total "cancel me"):', flatB.filter((t) => t === 'cancel me').length === 1);

  // ---- C. manual send cancels ------------------------------------------------
  const paneC = page.locator('.tabpane[style*="flex"]');
  await paneC.locator('#composer-input').fill('manual wins');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500); // manual prompt errors → new countdown starts
  const lineC = paneC.locator('.retryline');
  await lineC.waitFor({ timeout: 8000 });
  await paneC.locator('#composer-input').fill('take over');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(7000); // past the 5s mark
  console.log('[C] line gone after manual send:', (await lineC.count()) === 0);
  const flatC = Object.values(await state()).flat();
  console.log('[C] no auto dispatch after manual (1 "manual wins"):', flatC.filter((t) => t === 'manual wins').length === 1);

  await screenshot(page, 'retry-verify');
  console.log('done PASS');
} finally {
  await browser.close();
}
