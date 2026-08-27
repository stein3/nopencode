import { BASE, launchBrowser, screenshot } from '../helpers/setup.mjs'

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => localStorage.removeItem('opencode.hideSubagents'));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.sidebar .item', { timeout: 10000 });
await page.waitForTimeout(800);

// 1. fresh profile: default = checked (hidden), label reads "hide subagents"
console.log('label:', (await page.$eval('.hidesub', (el) => el.textContent)).trim());
console.log('default checked:', await page.$eval('.hidesub input', (el) => el.checked));
console.log('default sub rows:', await page.$$eval('.sidebar .item.sub-row', (els) => els.length));
console.log('section:', (await page.$eval('.section', (el) => el.textContent)).replace(/\s+/g, ' ').trim());
await screenshot(page, 'subs-default-hidden');

// 2. uncheck -> subagents appear
await page.uncheck('.hidesub input');
await page.waitForTimeout(400);
console.log('after uncheck: sub rows =', await page.$$eval('.sidebar .item.sub-row', (els) => els.length));
await screenshot(page, 'subs-unchecked');

// 3. persisted across reload ('0' stored = shown)
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.sidebar .item', { timeout: 10000 });
await page.waitForTimeout(600);
console.log('after reload: checked =', await page.$eval('.hidesub input', (el) => el.checked),
  '| sub rows =', await page.$$eval('.sidebar .item.sub-row', (els) => els.length));

await browser.close();
console.log('OK');
