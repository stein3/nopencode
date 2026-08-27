// verify-model-badge.mjs — user messages show the model-id badge like
// assistant rows (msgModel: flat assistant fields + nested user `model`).
//
// Prereq (started by the caller, NOT by this script):
//   OC_ENGINE=127.0.0.1:4096 PORT=8123 HOST=127.0.0.1 python3 /workspace/opencode/chatserver.py &
import { BASE, ENGINE, launchBrowser, createChecker, screenshot, SHOTS_DIR } from '../helpers/setup.mjs'

const { check, summary } = createChecker()

const TITLE = 'model-badge probe';
const MODELS = [
  { providerID: 'opencode-go', modelID: 'ox-alpha-free' },
  { providerID: 'opencode', modelID: 'x-preview-f-free' },
];

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
let browser;
try {
  try {
    await main();
  } catch (e) {
    console.log('ERROR:', e.message ?? e);
  }
} finally {
  for (const id of [...new Set(created)]) {
    await eng('DELETE', `/session/${id}`).catch((e) => console.log('cleanup miss', id, e.message));
  }
  process.exit(summary());
}

async function main() {
  // ---- seed probe session with 2 noReply user msgs using DIFFERENT models
  const s = await eng('POST', '/session', { title: TITLE });
  created.push(s.id);
  for (const m of MODELS) {
    // message endpoint stamps `model:{providerID,modelID}` on the USER msg
    await eng('POST', `/session/${s.id}/message`, {
      parts: [{ type: 'text', text: `badge probe via ${m.providerID}/${m.modelID}` }],
      noReply: true,
      model: m,
    });
  }
  console.log('seeded', s.id, 'with', MODELS.length, 'user messages');

  // ---- pick pre-existing sessions from the engine:
  //      parity: an assistant msg with flat modelID; retro: a user msg with nested model.
  //      Only IDLE sessions (not updated in 10 min) — freshly-updated ones are
  //      live/TUI churn whose titles change between fetch and sidebar click.
  async function findSessions() {
    let parity = null, retro = null;
    const cutoff = Date.now() - 10 * 60 * 1000;
    const sessions = (await eng('GET', '/session'))
      .filter((x) => x.id !== s.id && !x.parentID && (x.time?.updated ?? 0) < cutoff)
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
    for (const cand of sessions.slice(0, 25)) {
      try {
        const msgs = await eng('GET', `/session/${cand.id}/message?limit=80`);
        const infos = (msgs ?? []).map((m) => m.info ?? m);
        if (!parity && infos.some((i) => i.role === 'assistant' && i.modelID)) parity = cand;
        if (!retro && infos.some((i) => i.role === 'user' && i.model?.modelID)) retro = cand;
        if (parity && retro) break;
      } catch { /* skip */ }
    }
    return { parity, retro };
  }
  const { parity, retro } = await findSessions();
  console.log('parity session:', parity?.id ?? 'NONE', '| retro session:', retro?.id ?? 'NONE');

  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1900 } }); // tall: content-visibility keeps rows painted
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('.sidebar .item', { timeout: 10000 });
  await page.waitForTimeout(1200);

  const pane = page.locator('.tabpane[style*="flex"]'); // active pane only

  // ---- [1] probe session: both user rows show the right badge + provider/model tooltip
  await page.click(`.sidebar .item[title="${TITLE}"]`);
  await pane.locator('.msg.user').first().waitFor({ timeout: 10000 });
  const userRows = pane.locator('.msg.user');
  check('[1] probe has 2 user rows', (await userRows.count()) === 2);
  for (let i = 0; i < MODELS.length; i++) {
    const badge = userRows.nth(i).locator('.model-id');
    const txt = (await badge.textContent()).trim();
    const tip = await badge.getAttribute('title');
    const want = MODELS[i];
    check(`[1] user row ${i + 1} badge text`, txt === want.modelID, `got "${txt}" want "${want.modelID}"`);
    check(
      `[1] user row ${i + 1} tooltip is provider/model`,
      tip === `${want.providerID}/${want.modelID}`,
      `got "${tip}"`,
    );
  }

  // ---- [2] assistant badge parity in a PRE-EXISTING session (unchanged rendering)
  if (parity) {
    const msgs = await eng('GET', `/session/${parity.id}/message?limit=80`);
    const aid = (msgs ?? []).map((m) => m.info ?? m).find((i) => i.role === 'assistant' && i.modelID);
    await page.click(`.sidebar .item[title="${(parity.title ?? '').replace(/"/g, '&quot;')}"]`);
    // wait for the REAL message row (a `.msg.errtile` sidecar tile also has
    // class .msg and renders before the transcript fetch lands)
    await pane.locator(`#m-${aid.id}`).waitFor({ timeout: 20000 });
    const tabTitle = await page.locator('.tabsbar .tab.active').first().innerText().catch(() => '?');
    console.log(`[dbg] active tab="${tabTitle.trim()}" rows=${await pane.locator('.msg').count()} user=${await pane.locator('.msg.user').count()}`);
    const abadge = pane.locator(`#m-${aid.id} .model-id`);
    if ((await abadge.count()) === 1) {
      const txt = (await abadge.textContent()).trim();
      const tip = await abadge.getAttribute('title');
      check('[2] assistant badge unchanged', txt === aid.modelID, `got "${txt}" want "${aid.modelID}"`);
      check('[2] assistant tooltip provider/model', tip === `${aid.providerID}/${aid.modelID}`, `got "${tip}"`);
    } else {
      // assistant row outside the newest-80 window — accept any visible assistant badge
      const anyBadge = pane.locator('.msg:not(.user) .model-id').first();
      check('[2] some assistant badge renders', (await anyBadge.count()) === 1);
    }
    // visual parity shot: last user row + adjacent assistant row if present
    const uRow = pane.locator('.msg.user').last();
    if (await uRow.count()) await uRow.screenshot({ path: `${SHOTS_DIR}/model-badge-user-old.png` }).catch(() => {});
  } else {
    console.log('SKIP [2]: no pre-existing assistant-model session found');
  }

  // ---- [3] retroactive win: OLD real session's user rows now show badges
  if (retro) {
    await page.click(`.sidebar .item[title="${(retro.title ?? '').replace(/"/g, '&quot;')}"]`);
    // real user message row, not an errtile (see [2])
    await pane.locator('.msg.user .head').first().waitFor({ timeout: 20000 });
    await page.waitForTimeout(500);
    const badges = pane.locator('.msg.user .model-id');
    const n = await badges.count();
    check('[3] old session shows >=1 user badge', n >= 1, `${n} badges`);
    if (n) {
      // textContent: content-visibility:auto skips offscreen paint, which makes
      // innerText '' even though the span exists with correct data
      const txt = (await badges.first().textContent()).trim();
      const tip = await badges.first().getAttribute('title');
      check('[3] old-session user badge non-empty', !!txt, `"${txt}"`);
      console.log(`[3] first old-session user badge: "${txt}" title="${tip}"`);
    }
  } else {
    console.log('SKIP [3]: no pre-existing user-model session found');
  }

  // ---- [4] element screenshots of probe user+assistant-style rows for parity
  await page.click(`.sidebar .item[title="${TITLE}"]`);
  await pane.locator('.msg.user').first().waitFor({ timeout: 10000 });
  await page.mouse.move(640, 900);
  await page.mouse.wheel(0, -400); // real wheel-up so stick-to-bottom stands down
  await page.waitForTimeout(300);
  await pane.locator('.msg.user').nth(0).screenshot({ path: `${SHOTS_DIR}/model-badge-user1.png` });
  await pane.locator('.msg.user').nth(1).screenshot({ path: `${SHOTS_DIR}/model-badge-user2.png` });
  console.log('shots saved:', `${SHOTS_DIR}/model-badge-user{1,2}.png`);
}
