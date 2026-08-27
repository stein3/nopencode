import { BASE, launchBrowser } from '../helpers/setup.mjs'

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.waitForTimeout(2500);

// start a new chat so the empty state shows
await page.keyboard.press('Control+t');
await page.locator('.empty select').waitFor({ timeout: 5000 });

const btn = page.locator('button.cur');
console.log('collapsed label before providers/pick:', JSON.stringify(await btn.textContent()));

// pick Ox Alpha Free via the empty-state dropdown
await page.selectOption('.empty select', 'opencode/x-preview-f-free');
await page.waitForTimeout(500);
console.log('collapsed label after pick (no menu open):', JSON.stringify(await btn.textContent()));

// open + close the topbar menu without picking, label must stay the name
await page.click('button[title="Select model"]');
await page.locator('.topbar .menu').waitFor({ timeout: 3000 });
await page.keyboard.press('Escape');
await page.click('button[title="Select model"]'); // toggle closed again
await page.waitForTimeout(300);
console.log('collapsed label after menu toggle:', JSON.stringify(await btn.textContent()));

// now switch to a different model via topbar menu and confirm label follows
await page.click('button[title="Select model"]');
await page.locator('.topbar .menu').waitFor({ timeout: 3000 });
await page.click('.topbar .menu button.m:has-text("Big Pickle")');
await page.waitForTimeout(400);
console.log('collapsed label after topbar switch:', JSON.stringify(await btn.textContent()));

await page.screenshot({ path: '/tmp/oc-probe/label-fixed.png' });
await browser.close();
console.log('done');
