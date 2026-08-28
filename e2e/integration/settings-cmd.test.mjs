// verify-settings-cmd.mjs — /settings builtin command opens the settings page
// via BOTH entry paths: ctrl+p palette ("setting" substring match) and the
// composer's inline "/" menu (prefix match, so literal "/setting" resolves).
// Serves against chatserver on :8123 (fresh dist picked up from disk).
import { BASE, launchBrowser } from '../helpers/setup.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sidebar .gear', { timeout: 15000 });
  const dialog = page.locator('.settings[role="dialog"]');

  // ---- palette path: ctrl+p → "setting" → Enter ---------------------------
  await page.keyboard.press('Control+p');
  await page.waitForSelector('.panel input', { timeout: 5000 });
  await page.keyboard.type('setting');
  await sleep(200);
  const row = page.locator('.panel .row', { hasText: 'Open settings' });
  check('palette lists /settings for "setting"', (await row.count()) === 1);
  const desc = (await row.first().locator('.desc').textContent())?.trim();
  check('description reads "Open settings"', desc === 'Open settings', desc);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.settings[role="dialog"]', { timeout: 5000 });
  check('palette Enter opens settings page', await dialog.isVisible());
  // close again for the next path
  await page.keyboard.press('Escape');
  await sleep(150);
  check('Esc closes after palette open', (await dialog.count()) === 0);

  // ---- composer slash path: type "/setting" → menu shows it → click -------
  const input = page.locator('.tabpane[style*="flex"] #composer-input:visible').first();
  await input.click();
  await input.fill('/setting');
  await sleep(300);
  const menuItem = page.locator('.menu[role="listbox"] .row', { hasText: '/settings' });
  const menuHits = await menuItem.count();
  check('composer slash menu lists settings for "/setting"', menuHits >= 1);
  if (menuHits >= 1) {
    await menuItem.first().click();
    await page.waitForSelector('.settings[role="dialog"]', { timeout: 5000 });
    check('composer menu click opens settings page', await dialog.isVisible());
    // composer must NOT have sent "/setting" as a message
    const bodyText = await page.locator('.tabpane[style*="flex"]').first().textContent();
    check('no stray "/setting" message sent', !bodyText?.includes('/setting'));
  }
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
