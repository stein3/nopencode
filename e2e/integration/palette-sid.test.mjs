import { BASE, launchBrowser, screenshot } from '../helpers/setup.mjs'

// Verifies the ctrl+p palette resolves the ACTIVE session id at command-run
// time (regression for the frozen sessionId prop, which was computed once at
// App mount and left every session-scoped palette command with null):
//   A. open session A -> /rename  -> PATCH /oc/session/<A>
//      open session B -> /rename  -> PATCH /oc/session/<B>   (freshness)
//   B. pending tab (ctrl+t) -> /rename -> "no session yet" toast, no PATCH
// PATCH is intercepted (no real mutation). /rename now opens the in-app
// RenameDialog (#rename-input); any NATIVE dialog is a failure signal.

const patches = []; // {sid, title}
let histSids = [];

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
page.on('dialog', (d) => {
  console.log('UNEXPECTED NATIVE DIALOG:', d.message());
  d.dismiss();
});

await page.route('**/api/history/sessions', async (route) => {
  const res = await route.fetch();
  const body = await res.json();
  // two most-recently-updated non-subagent sessions to click on
  histSids = body
    .filter((s) => !s.parent && s.title)
    .sort((a, b) => b.updated - a.updated)
    .slice(0, 2)
    .map((s) => ({ id: s.id, title: s.title }));
  await route.fulfill({ response: res });
});

await page.route('**/oc/session/*', async (route) => {
  const req = route.request();
  if (req.method() !== 'PATCH') return route.fallback();
  const m = new URL(req.url()).pathname.match(/\/oc\/session\/([^/]+)$/);
  const sid = m ? decodeURIComponent(m[1]) : null;
  let body = {};
  try {
    body = JSON.parse(req.postData() ?? '{}');
  } catch {}
  patches.push({ sid, title: body.title });
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ id: sid, title: 'renamed-probe' }),
  });
});

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('button.item .title', { timeout: 15000 });
for (let i = 20; i-- && !histSids.length; ) await page.waitForTimeout(150);
if (histSids.length < 2) throw new Error('could not capture history session list');

async function paletteRunRename() {
  await page.keyboard.press('Control+p');
  const input = page.locator('.panel input');
  await input.waitFor({ state: 'visible', timeout: 4000 });
  await input.fill('rename');
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('.palette-list .row, .list .row')];
    // palette rows show TUI-style titles now ("Rename session"), not /name
    return rows.some((r) => r.textContent.toLowerCase().includes('rename'));
  }, null, { timeout: 4000 }).catch(() => {
    throw new Error('/rename row not found in palette');
  });
  await page.keyboard.press('Enter');
}

async function submitRenameDialog(title) {
  // themed RenameDialog opens with the current title prefilled
  const renameInput = page.locator('#rename-input');
  await renameInput.waitFor({ state: 'visible', timeout: 4000 });
  const pre = await renameInput.inputValue();
  if (!pre) throw new Error('rename dialog opened with empty prefill');
  console.log('ok – dialog prefilled with current title:', JSON.stringify(pre.slice(0, 40)));
  await renameInput.fill(title);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600); // allow PATCH + tabs.patch to land
}

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('ok –', msg);
}

// --- A1: session A ---
await page.locator('button.item', { hasText: histSids[0].title.slice(0, 30) }).first().click();
await page.waitForTimeout(500);
await paletteRunRename();
await submitRenameDialog('palette-sid-probe');
assert(patches.length === 1 && patches[0].sid === histSids[0].id,
  `PATCH went to session A (${patches[0]?.sid} === ${histSids[0].id})`);
assert(patches[0].title === 'palette-sid-probe', `PATCH carried typed title "${patches[0].title}"`);
// tabs.patch applied the (mock) engine response title to the tab bar
await page.waitForFunction(
  () =>
    [...document.querySelectorAll('.tabbar .label')].some((l) =>
      l.textContent.includes('renamed-probe'),
    ),
  null,
  { timeout: 4000 },
);
console.log('ok – tab bar shows engine-returned title "renamed-probe"');

// --- A2: switch to session B, palette must pick up B's id ---
patches.length = 0;
await page.locator('button.item', { hasText: histSids[1].title.slice(0, 30) }).first().click();
await page.waitForTimeout(500);
await paletteRunRename();
await submitRenameDialog('palette-sid-probe');
assert(patches.length === 1 && patches[0].sid === histSids[1].id,
  `after tab switch PATCH went to session B (${patches[0]?.sid} === ${histSids[1].id})`);

// --- B: pending tab still refuses politely — toast, no dialog, no PATCH ---
patches.length = 0;
await page.keyboard.press('Control+t');
await page.waitForTimeout(300);
await paletteRunRename();
await page.waitForFunction(
  () => /no session yet/.test(document.querySelector('.toast')?.textContent ?? ''),
  null,
  { timeout: 4000 },
);
assert(!(await page.locator('#rename-input').isVisible().catch(() => false)),
  'pending tab did not open the rename dialog');
assert(patches.length === 0, 'pending tab produced no PATCH');

// --- C: themed-dialog screenshot (visual check of the panel) ---
await page.locator('button.item', { hasText: histSids[0].title.slice(0, 30) }).first().click();
await page.waitForTimeout(500);
await paletteRunRename();
await page.locator('#rename-input').waitFor({ state: 'visible', timeout: 4000 });
await screenshot(page, 'rename-dialog');
console.log('ok – screenshot saved: rename-dialog.png');

await browser.close();
console.log('\nALL CHECKS PASSED');
