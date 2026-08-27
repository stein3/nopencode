import { BASE, ENGINE, launchBrowser } from '../helpers/setup.mjs'

const browser = await launchBrowser()
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

// open the newest real session (has assistant messages with modelID)
const sids = await (await fetch(`${ENGINE}/session`)).json();
sids.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
const sid = sids[0].id;
console.log('opening session', sid, '| model:', sids[0].model?.id);

await page.goto(`${BASE}/?session=${sid}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.waitForSelector('.msg:not(.user) .head .model-id', { timeout: 10000 });
await page.waitForTimeout(1200);

const rows = await page.$$eval('.msg .head', (heads) =>
  heads.slice(0, 6).map((h) =>
    [...h.children].map((c) => c.textContent.trim()).filter(Boolean).join(' | ')
  )
);
console.log(rows.join('\n'));

await page.screenshot({ path: '/tmp/oc-probe/model-id.png' });
await browser.close();
console.log('OK');
