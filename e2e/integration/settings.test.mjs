// verify-settings.mjs — headless validation for the Settings page + sidebar
// gear button. Drives the FRESHLY BUILT webui/dist served by chatserver.py
// (started separately: OC_ENGINE=127.0.0.1:4096 PORT=8123 HOST=127.0.0.1
// python3 /workspace/opencode/chatserver.py &) against the sandbox engine.
//
// Checks:
//   G1 gear button sits LEFT of "New chat" inside .top, both visible
//   S2 gear click opens the settings page (role=dialog, header)
//   T3 four pref toggles render; hide-subagents defaults ON (checked)
//   T4 toggling writes localStorage through the stores (hideSubagents,
//      showTimestamps, infoOpen via toggleInfo)
//   R5 read-only session defaults show the seeded model + agent line
//   M6 model recents: seeded count renders, Clear empties list + key
//   E7 Escape closes the page
//   P8 toggles survive a reload (store-backed persistence)
//   D9 danger zone: Keep cancels; "Yes, erase" wipes every opencode.* key
//     and reloads back to defaults
// Shots: webui/.webtest/shots/settings-*.png
//
// Run: node e2e/integration/settings.test.mjs

import { BASE, SHOTS_DIR, launchBrowser, screenshot } from '../helpers/setup.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
function check(name, ok, extra = '') {
  if (ok) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`);
  }
}

const browser = await launchBrowser();

try {
  // ============================ desktop =====================================
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('.sidebar .item', { timeout: 15000 });

  // seed prefs AFTER first load, then reload so stores read them at boot
  await page.evaluate(() => {
    localStorage.setItem(
      'opencode.modelRecents',
      JSON.stringify([
        { providerID: 'opencode', modelID: 'x-preview-f-free' },
        { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
      ]),
    );
    localStorage.setItem('opencode.model', JSON.stringify({ providerID: 'opencode', modelID: 'x-preview-f-free' }));
    localStorage.setItem('opencode.sessionAgents', JSON.stringify({ ses_seed: 'plan' }));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sidebar .item', { timeout: 15000 });
  await sleep(600);

  // G1 — gear left of New chat, both visible
  const gearInfo = await page.evaluate(() => {
    const top = document.querySelector('.sidebar .top');
    const gear = top?.querySelector('.gear');
    const neu = top?.querySelector('.new');
    if (!top || !gear || !neu) return null;
    const g = gear.getBoundingClientRect();
    const n = neu.getBoundingClientRect();
    return {
      kids: [...top.children].map((c) => c.className.split(' ')[0]),
      gearLeftOfNew: g.right <= n.left + 1,
      bothVisible: g.width > 0 && n.width > 0,
      gearTitle: gear.getAttribute('title'),
    };
  });
  check('G1 gear exists in .top', !!gearInfo);
  check('G1 gear is FIRST child (left of New chat)', gearInfo?.kids?.[0] === 'gear', JSON.stringify(gearInfo?.kids));
  check('G1 gear left of New chat, both visible', !!gearInfo?.gearLeftOfNew && !!gearInfo?.bothVisible);
  check('G1 tooltip says Settings', gearInfo?.gearTitle === 'Settings');

  await screenshot(page, 'settings-sidebar-gear');

  // S2 — open
  await page.click('.sidebar .gear');
  await page.waitForSelector('.settings', { timeout: 5000 });
  check('S2 settings page opens', true);
  check(
    'S2 role=dialog labelled Settings',
    (await page.getAttribute('.settings', 'role')) === 'dialog',
  );
  check('S2 header title', (await page.textContent('.settings .htitle'))?.trim() === 'Settings');

  // T3 — toggles render with sane defaults
  const names = await page.$$eval('.settings .row .name', (els) => els.map((e) => e.textContent.trim()));
  check(
    'T3 four display prefs listed',
    ['Hide subagents', 'Show message timestamps', 'Always expand thinking blocks', 'Info panel open'].every((n) =>
      names.includes(n),
    ),
    JSON.stringify(names),
  );
  const rowBy = (t) => page.locator('.settings .row', { hasText: t });
  check('T3 hide-subagents defaults ON', await rowBy('Hide subagents').locator('input').isChecked());

  // T4 — flips persist through the stores to localStorage
  await rowBy('Hide subagents').click();
  await sleep(120);
  check(
    'T4 hideSubagents OFF → ls "0"',
    (await page.evaluate(() => localStorage.getItem('opencode.hideSubagents'))) === '0',
  );
  await rowBy('Hide subagents').click();
  await sleep(120);
  check(
    'T4 hideSubagents ON → ls "1"',
    (await page.evaluate(() => localStorage.getItem('opencode.hideSubagents'))) === '1',
  );
  await rowBy('Show message timestamps').click();
  await sleep(120);
  check(
    'T4 showTimestamps OFF → ls "0"',
    (await page.evaluate(() => localStorage.getItem('opencode.showTimestamps'))) === '0',
  );
  const infoBefore = await page.evaluate(() => localStorage.getItem('opencode.infoOpen'));
  await rowBy('Info panel open').click();
  await sleep(120);
  const infoAfter = await page.evaluate(() => localStorage.getItem('opencode.infoOpen'));
  check('T4 infoOpen flip persists via toggleInfo', infoBefore !== infoAfter, `${infoBefore}→${infoAfter}`);
  await rowBy('Info panel open').click(); // restore
  await sleep(100);

  // R5 — read-only picks
  const modelTxt = (await page.textContent('.settings .grid')).replace(/\s+/g, ' ');
  check('R5 model line shows seeded model', modelTxt.includes('opencode / x-preview-f-free'), modelTxt);
  check('R5 agent line present (Auto default)', modelTxt.includes('Auto (session default)'), modelTxt);

  // M6 — recents
  check(
    'M6 recents count shows 2 saved',
    ((await page.textContent('.settings .rechead .count')) || '').includes('2 saved'),
  );
  check('M6 recents lists 2 entries', (await page.$$('.settings .reclist li')).length === 2);
  await page.click('.settings .rechead .ghostbtn');
  await sleep(150);
  check('M6 clear empties list UI', !!(await page.$('.settings .empty')));
  check(
    'M6 clear removes ls key',
    (await page.evaluate(() => localStorage.getItem('opencode.modelRecents'))) === null,
  );

  await screenshot(page, 'settings-open');

  // E7 — Escape closes
  await page.keyboard.press('Escape');
  await sleep(150);
  check('E7 Escape closes settings', !(await page.$('.settings')));

  // P8 — persistence across reload
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sidebar .gear', { timeout: 15000 });
  await page.click('.sidebar .gear');
  await page.waitForSelector('.settings', { timeout: 5000 });
  check('P8 timestamps stayed OFF after reload', !(await rowBy('Show message timestamps').locator('input').isChecked()));
  check('P8 hide-subagents stayed ON after reload', await rowBy('Hide subagents').locator('input').isChecked());
  await page.click('.settings .close'); // close-button affordance works too
  await sleep(120);
  check('P8 ✕ button closes settings', !(await page.$('.settings')));

  // D9 — danger zone
  await page.click('.sidebar .gear');
  await page.waitForSelector('.settings', { timeout: 5000 });
  await page.click('.settings .wipe');
  await sleep(120);
  check('D9 confirm step appears', !!(await page.$('.settings .confirm')));
  check('D9 confirm copy warns', ((await page.textContent('.settings .confirm')) || '').includes('Erase everything?'));
  await screenshot(page, 'settings-confirm');
  // Keep cancels
  await page.locator('.settings .confirm .ghostbtn').click();
  await sleep(120);
  check('D9 Keep cancels wipe', !(await page.$('.settings .confirm')));
  check(
    'D9 nothing erased after cancel',
    (await page.evaluate(() => localStorage.getItem('opencode.showTimestamps'))) === '0',
  );

  // real wipe
  await page.click('.settings .wipe');
  await sleep(120);
  await page.locator('.settings .wipe.yes').click();
  await page.waitForSelector('.sidebar .gear', { timeout: 15000 }); // reload landed
  await sleep(500);
  // NOTE: opencode.openTabs / opencode.model legitimately reappear right
  // after the reload (tab-restore persistence + model default-seed run on
  // every boot) — the wipe is proven by USER data staying gone + defaults.
  const post = await page.evaluate(() => ({
    timestamps: localStorage.getItem('opencode.showTimestamps'),
    agents: localStorage.getItem('opencode.sessionAgents'),
    recents: localStorage.getItem('opencode.modelRecents'),
    hide: localStorage.getItem('opencode.hideSubagents'),
  }));
  check('D9 wipe clears pref values', post.timestamps === null && post.agents === null && post.recents === null, JSON.stringify(post));
  check('D9 settings closed after wipe-reload', !(await page.$('.settings')));
  check(
    'D9 prefs back to defaults (hide ON)',
    await page.$eval('.hidesub input', (el) => el.checked),
  );

  await ctx.close();

  // ============================ mobile ======================================
  const mctx = await browser.newContext({ viewport: { width: 420, height: 840 } });
  const mpage = await mctx.newPage();
  mpage.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
  await mpage.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await mpage.waitForSelector('.sidebar .gear', { timeout: 15000 });
  await mpage.click('.sidebar .gear');
  await mpage.waitForSelector('.settings', { timeout: 5000 });
  await sleep(300);
  const overflow = await mpage.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check('MOB no horizontal overflow @420px', overflow <= 1, `overflow=${overflow}px`);
  await screenshot(mpage, 'settings-mobile');
  await mctx.close();
} finally {
  await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
