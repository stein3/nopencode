import { BASE, ENGINE, launchBrowser, createChecker, screenshot, SHOTS_DIR } from '../helpers/setup.mjs'

const { check, summary } = createChecker()
const TITLE = 'FORKPROBE-ui';

async function eng(method, p, body) {
  const r = await fetch(ENGINE + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok && r.status !== 204) throw new Error(`${method} ${p} -> ${r.status}`);
  const raw = await r.text();
  return raw ? JSON.parse(raw) : null;
}

const created = [];
try {
  // ---- seed a probe session with 3 user messages (noReply → no LLM turns)
  const s = await eng('POST', '/session', { title: TITLE });
  created.push(s.id);
  const mids = [];
  for (let i = 1; i <= 3; i++) {
    const m = await eng('POST', `/session/${s.id}/message`, {
      parts: [{ type: 'text', text: `forkprobe message ${i}` }],
      noReply: true,
    });
    mids.push(m.info.id);
  }
  console.log('seeded', s.id, mids.length, 'messages');

  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('.sidebar .item', { timeout: 10000 });
  await page.waitForTimeout(1200); // let the session list populate

  // ---- open the probe session from the sidebar
  await page.click(`.sidebar .item[title="${TITLE}"]`);
  await page.waitForTimeout(1500);
  const rows = await page.locator('.tabpane:visible .msg.user').count();
  console.log('[1] user rows in opened tab:', rows);

  // ---- hover the SECOND user message and click its fork button
  const second = page.locator('.tabpane:visible .msg.user').nth(1);
  await second.hover();
  const forkBtn = second.locator('button[title^="Fork a new session"]');
  if (!(await forkBtn.isVisible())) throw new Error('fork button not visible on hover');
  const btns = await second.locator('.acts button').count();
  console.log('[2] acts buttons on user row:', btns, '(expect 3: revert/fork/delete)');
  await forkBtn.click();

  // ---- new tab must activate, be titled by the engine, show 1 user msg
  await page.waitForTimeout(2000);
  const activeTitle = await page.locator('.tabsbar .tab.active, .tab.active').first().innerText().catch(() => '?');
  const forkRows = await page.locator('.tabpane:visible .msg.user').count();
  const inputVal = await page.inputValue('#composer-input:visible');
  console.log('[3] after fork click:');
  console.log('    active tab title:', JSON.stringify(activeTitle.trim()));
  console.log('    user rows in new tab:', forkRows, '(expect 1 — exclusive semantics)');
  console.log('    composer prefilled:', JSON.stringify(inputVal));

  check(forkRows === 1, `[3] expected exactly 1 user message, got ${forkRows}`);
  check(inputVal === 'forkprobe message 2', `[3] composer should hold message-2 text`);
  check(/fork/i.test(activeTitle), `[3] active tab should be the fork`);

  // ---- original tab untouched?
  const origTab = page.locator(`.tabbar .tab[title="${TITLE}"]`).first();
  await origTab.click();
  await page.waitForTimeout(800);
  const origRows = await page.locator('.tabpane:visible .msg.user').count();
  console.log('[4] original tab still has:', origRows, 'user rows (expect 3)');
  check(origRows === 3, `[4] source session mutated`);

  await screenshot(page, 'fork-verify');

  // ---- cleanup: close browser first, then delete probe sessions via engine
  await browser.close();

  // find the engine-side fork session(s) of our probe (children listing not
  // used — forks are standalone; find via sessions list by title prefix)
  const sessions = await eng('GET', '/session');
  for (const x of sessions) {
    if ((x.title ?? '').startsWith(TITLE)) created.push(x.id);
  }
  console.log('cleanup:', [...new Set(created)].length, 'sessions');
} finally {
  for (const id of [...new Set(created)]) {
    await eng('DELETE', `/session/${id}`).catch((e) => console.log('cleanup miss', id, e.message));
  }
  process.exit(summary());
}
