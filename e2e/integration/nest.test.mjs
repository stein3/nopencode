import { BASE, launchBrowser, screenshot } from '../helpers/setup.mjs'

const NOW = Date.now();
const M = 60000;
const SESSIONS = [
  { id: 'ses_root', title: 'Root session', created: NOW - 90 * M, updated: NOW - 10 * M, message_count: 12, cost: 0, model: 'x-preview-f-free' },
  { id: 'ses_sub', title: 'Find stuff (@explore subagent)', created: NOW - 5 * M, updated: NOW - 1 * M, message_count: 2, cost: 0, model: 'ox-alpha-free', parent: 'ses_root', agent: 'explore' },
  { id: 'ses_orph', title: 'Orphan task (@general subagent)', created: NOW - 40 * M, updated: NOW - 20 * M, message_count: 3, cost: 0, model: 'ox-alpha-free', parent: 'ses_missing', agent: 'general' },
  { id: 'ses_root2', title: 'Second root', created: NOW - 80 * M, updated: NOW - 30 * M, message_count: 5, cost: 0, model: 'x-preview-f-free' },
];

const browser = await launchBrowser();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
page.on('dialog', (d) => { console.log('DIALOG:', d.message()); d.dismiss(); });

// ---- mocks ---------------------------------------------------------------
await page.route('**/api/history/sessions', (r) =>
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SESSIONS) }));
await page.route('**/api/history/session/*', (r) =>
  r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
await page.route('**/oc/session/status', (r) =>
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ses_sub: { type: 'busy' } }) }));
await page.route('**/oc/permission', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
await page.route('**/oc/session/ses_*/message', (r) =>
  r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

// ---- 1. auto-open picks the most recent ROOT, never the sub ---------------
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.waitForSelector('.tabbar .tab .label', { timeout: 10000 });
await page.waitForTimeout(800);
const tabTitle = await page.$eval('.tabbar .tab .label', (el) => el.textContent.trim());
console.log('[1] auto-opened tab:', JSON.stringify(tabTitle), tabTitle === 'Root session' ? '✓ root not sub' : '✗ WRONG');

// ---- 2. uncheck "hide subagents" -> tree mode -----------------------------
await page.uncheck('.hidesub input');
await page.waitForTimeout(400);
const section = (await page.$eval('.section .count', (el) => el.textContent)).replace(/\s+/g, ' ').trim();
console.log('[2] section count:', JSON.stringify(section));
const topTitles = await page.$$eval('.list .item > .row1 .title', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
console.log('[2] top-level rows:', topTitles.length, '| orphan top-level:', topTitles.some((t) => t.includes('Orphan task')));
const chev = await page.$$eval('.chev', (els) => els.length);
const kidcount = await page.$eval('.kidcount', (el) => el.textContent).catch(() => null);
const aggdot = await page.$eval('.aggdot.busy', (el) => getComputedStyle(el).backgroundColor).catch(() => null);
console.log('[2] chevrons:', chev, '| kidcount:', kidcount, '| aggdot.busy:', aggdot);
const subVisibleDefault = await page.$$eval('.item.child', (els) => els.length);
console.log('[2] child rows visible by default (want 0):', subVisibleDefault);
await screenshot(page, 'nest-collapsed');

// ---- 3. expand -> nested row with badge + indent; persists ----------------
await page.click('.chev');
await page.waitForTimeout(300);
const childRow = await page.$eval('.item.child', (el) => ({
  text: el.textContent.replace(/\s+/g, ' ').trim(),
  padLeft: getComputedStyle(el).paddingLeft,
  guide: getComputedStyle(el, '::before').width,
})).catch(() => null);
console.log('[3] child row:', childRow ? childRow.text.slice(0, 60) : 'MISSING', '| indent:', childRow?.padLeft, '| guide:', childRow?.guide);
const stored = await page.evaluate(() => localStorage.getItem('opencode.subExpanded'));
console.log('[3] persisted expanded set:', stored);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.item', { timeout: 10000 });
await page.waitForTimeout(600);
console.log('[3] after reload: child rows =', await page.$$eval('.item.child', (els) => els.length), '(want 1, persisted)');

// ---- 4. collapse again -> aggdot returns ----------------------------------
await page.click('.chev');
await page.waitForTimeout(300);
console.log('[4] collapsed again: child rows =', await page.$$eval('.item.child', (els) => els.length),
  '| aggdot.busy =', await page.$eval('.aggdot.busy', (el) => el.title).catch(() => 'MISSING'));
await screenshot(page, 'nest-aggdot');

// ---- 5. hide checkbox still flattens --------------------------------------
await page.check('.hidesub input');
await page.waitForTimeout(300);
console.log('[5] hidden mode: child rows =', await page.$$eval('.item.child', (els) => els.length),
  '| chevrons =', await page.$$eval('.chev', (els) => els.length),
  '| section =', (await page.$eval('.section .count', (el) => el.textContent)).replace(/\s+/g, ' ').trim());

await ctx.close();

// ---- 6. real-engine smoke: tree renders with live data --------------------
const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const p2 = await ctx2.newPage();
p2.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await p2.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 });
await p2.waitForSelector('.sidebar .item', { timeout: 10000 });
await p2.waitForTimeout(800);
await p2.evaluate(() => localStorage.setItem('opencode.hideSubagents', '0'));
await p2.reload({ waitUntil: 'domcontentloaded' });
await p2.waitForSelector('.sidebar .item', { timeout: 10000 });
await p2.waitForTimeout(800);
const real = await p2.evaluate(() => ({
  chevrons: document.querySelectorAll('.chev').length,
  kids: document.querySelectorAll('.item.child').length,
  kidcounts: [...document.querySelectorAll('.kidcount')].map((e) => e.textContent).slice(0, 5),
  section: document.querySelector('.section .count')?.textContent.replace(/\s+/g, ' ').trim(),
}));
console.log('[6] real engine:', JSON.stringify(real));
await p2.click('.chev');
await p2.waitForTimeout(400);
console.log('[6] after expand: child rows =', await p2.$$eval('.item.child', (els) => els.length));
await screenshot(p2, 'nest-real');

await ctx2.close();
await browser.close();
console.log('OK');
