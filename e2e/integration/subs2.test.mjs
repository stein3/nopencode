import { BASE, launchBrowser, screenshot } from '../helpers/setup.mjs'

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

// clean persisted state -> default (show all)
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => localStorage.removeItem('opencode.hideSubagents'));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.sidebar .item', { timeout: 10000 });
await page.waitForTimeout(800);

console.log('default checkbox:', await page.$eval('.hidesub input', (el) => el.checked));
console.log('sub rows:', await page.$$eval('.sidebar .item.sub-row', (els) => els.length));
await screenshot(page, 'subs-shown');

await page.check('.hidesub input');
await page.waitForTimeout(400);
await screenshot(page, 'subs-hidden2');

// open a subagent session from the list (uncheck first so rows exist)
await page.uncheck('.hidesub input');
await page.waitForTimeout(300);
// groups render COLLAPSED by default (fresh profile = empty subExpanded set),
// so a .sub-row only exists after expanding a parent — expand the first one
const chev = await page.$('.sidebar .item .chev');
if (chev) {
  await chev.click();
  await page.waitForTimeout(300);
}
await page.click('.sidebar .item.sub-row');
await page.waitForSelector('.msg', { timeout: 10000 });
console.log('subagent session opens OK');

await browser.close();
console.log('OK');
