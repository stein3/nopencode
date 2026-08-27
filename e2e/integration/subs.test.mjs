import { BASE, launchBrowser, screenshot } from '../helpers/setup.mjs'

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.waitForSelector('.sidebar .item', { timeout: 10000 });
await page.waitForTimeout(800);

// 1. default: subagent rows visible, badge + cleaned title
const subRows = await page.$$eval('.sidebar .item.sub-row', (els) =>
  els.slice(0, 4).map((el) => el.textContent.replace(/\s+/g, ' ').trim())
);
console.log('sub rows visible:', subRows.length);
console.log(subRows.join('\n'));

// 2. toggle the checkbox -> subagents hidden
await page.check('.hidesub input');
await page.waitForTimeout(400);
const afterHide = await page.$$eval('.sidebar .item.sub-row', (els) => els.length);
const sectionTxt = await page.$eval('.sidebar .section', (el) => el.textContent.replace(/\s+/g, ' ').trim());
const stored = await page.evaluate(() => localStorage.getItem('opencode.hideSubagents'));
console.log('after check: sub rows =', afterHide, '| section:', sectionTxt, '| localStorage:', stored);
await screenshot(page, 'subs-hidden');

// 3. uncheck -> back, and persistence across reload
await page.uncheck('.hidesub input');
await page.waitForTimeout(300);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.sidebar .item', { timeout: 10000 });
await page.waitForTimeout(600);
const checkedAfterReload = await page.$eval('.hidesub input', (el) => el.checked);
const subAfterReload = await page.$$eval('.sidebar .item.sub-row', (els) => els.length);
console.log('after reload: checkbox =', checkedAfterReload, '| sub rows =', subAfterReload);

// 4. reload with persisted hide
await page.check('.hidesub input');
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.sidebar .item', { timeout: 10000 });
await page.waitForTimeout(600);
console.log('reload w/ persisted: checkbox =', await page.$eval('.hidesub input', (el) => el.checked),
  '| sub rows =', await page.$$eval('.sidebar .item.sub-row', (els) => els.length));

await browser.close();
console.log('OK');
