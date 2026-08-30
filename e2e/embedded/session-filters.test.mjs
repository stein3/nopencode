// session-filters.test.mjs — sidebar toggle, tagging, stars, folders, filters
//
// Self-contained embedded test (same pattern as settings.test.mjs):
// serves webui/dist + stub /oc + fixture endpoints + SSE, driven via
// /__ctl and introspected via /__state.
//
// Checks:
//   S1  sidebar visible on load; burger button toggles it closed/reopen
//   T1  tag chips render on tagged sessions (single + multi-tag)
//   T2  clicking a tag chip opens TagPopover; "ux" shows as applied
//   T3  creating a new tag via TagPopover input persists on the row
//   T4  removing a tag via TagPopover toggle removes the chip
//   F1  star button shows ★ for starred, ☆ for unstarred
//   F2  clicking star toggles star state + persists to localStorage
//   F3  folder button shows .foldered class for foldered sessions
//   F4  clicking folder button opens picker; selecting folder assigns it
//   F5  creating new folder via picker input assigns it
//   F6  "Remove from folder" clears the folder assignment
//   R1  filter bar visible when metadata exists (stars/tags/folders)
//   R2  filter bar hidden when search query is active
//   R3  star filter shows only starred sessions
//   R4  tag filter shows only sessions with that tag
//   R5  untagged filter shows only sessions without tags
//   R6  folder filter shows only sessions in that folder
//   R7  multi-filter (star + tag) is AND intersection
//   R8  clear button deactivates all filters and restores full list
//   R9  tags/star/folder persist across page reload
//
// Run: node e2e/embedded/session-filters.test.mjs

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, launchBrowser, sleep, poll, screenshot, SHOTS_DIR } from '../helpers/setup.mjs';

const PORT = 8165;
const BASE = `http://127.0.0.1:${PORT}`;

// ============================== fixtures ====================================

const NOW = Date.now();
const SESSIONS = [
  { id: 'ses_ux1', title: 'Starred session',    created: NOW - 500_000, updated: NOW - 100_000, message_count: 4, cost: 0 },
  { id: 'ses_ux2', title: 'Tagged with ux',      created: NOW - 400_000, updated: NOW - 90_000,  message_count: 2, cost: 0 },
  { id: 'ses_ux3', title: 'Multi-tagged in folder', created: NOW - 300_000, updated: NOW - 80_000, message_count: 3, cost: 0 },
  { id: 'ses_ux4', title: 'Plain session',       created: NOW - 200_000, updated: NOW - 70_000,  message_count: 1, cost: 0 },
  { id: 'ses_ux5', title: 'Archived session',    created: NOW - 100_000, updated: NOW - 60_000,  message_count: 2, cost: 0 },
];

// sessionMeta seeded into localStorage after first load
const META = {
  ses_ux1: { star: true },
  ses_ux2: { tags: ['ux'] },
  ses_ux3: { tags: ['ux', 'backend'], folder: 'proj' },
  ses_ux4: {},
  ses_ux5: { folder: 'archive' },
};

const STATUS = {};
const PERMISSIONS = [];

// ============================== fake server =================================

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};
const json = (res, obj, code = 200) => {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length });
  res.end(b);
};
function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => resolve(d));
  });
}

const sseClients = new Set();
function sseEmit(type, properties = {}) {
  const frame = `data: ${JSON.stringify({ type, properties })}\n\n`;
  for (const res of sseClients) try { res.write(frame); } catch {}
}

const state = { counts: {} };

const server = http.createServer(async (req, res) => {
  const p = req.url.split('?')[0];
  state.counts[p] = (state.counts[p] ?? 0) + 1;
  try {
    // ---- test introspection + control -------------------------------------
    if (p === '/__state') return json(res, { sessions: SESSIONS, status: STATUS, counts: state.counts });
    if (p === '/__ctl') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (body.status) Object.assign(STATUS, body.status);
      if (body.emit) sseEmit(body.emit.type, body.emit.properties ?? {});
      return json(res, { ok: true });
    }

    // ---- SSE ----------------------------------------------------------------
    if (p === '/oc/event') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    // ---- history (chatserver stubs) -----------------------------------------
    if (p === '/api/history/sessions') return json(res, SESSIONS);
    if (p.startsWith('/api/history/session/')) return json(res, []);
    if (p.endsWith('/errors')) {
      if (req.method === 'GET') return json(res, []);
      return json(res, { ok: true });
    }
    if (p === '/api/search') return json(res, []);

    // ---- engine stubs -------------------------------------------------------
    if (p === '/oc/session/status') return json(res, STATUS);
    if (p === '/oc/permission') return json(res, PERMISSIONS);
    if (p === '/oc/question') return json(res, []);
    const mMsg = p.match(/^\/oc\/session\/([^/]+)\/message$/);
    if (mMsg) return json(res, []);
    const mTodo = p.match(/^\/oc\/session\/([^/]+)\/todo$/);
    if (mTodo) return json(res, []);
    const mSes = p.match(/^\/oc\/session\/([^/]+)$/);
    if (mSes) {
      const s = SESSIONS.find((x) => x.id === mSes[1]);
      return json(res, { id: mSes[1], title: s?.title ?? 'session', revert: null });
    }
    if (p === '/oc/session' && req.method === 'POST') {
      return json(res, { id: 'ses_new', title: 'new session', revert: null }, 201);
    }
    if (p === '/oc/session' && req.method === 'GET') return json(res, SESSIONS);
    if (p === '/oc/config/providers')
      return json(res, {
        providers: [{ id: 'opencode', models: { 'x-preview-f-free': { id: 'x-preview-f-free' } } }],
      });
    if (p === '/oc/path') return json(res, { directory: '/workspace' });
    if (p === '/oc/mcp') return json(res, {});
    if (p === '/oc/skill') return json(res, []);
    if (p === '/oc/agent') return json(res, []);
    if (p.startsWith('/oc/')) return json(res, []);

    // ---- statics (webui/dist) -----------------------------------------------
    const rel = p === '/' ? '/index.html' : p;
    const full = fs.realpathSync(path.join(DIST, rel));
    if (!full.startsWith(fs.realpathSync(DIST)) || !fs.statSync(full).isFile())
      return json(res, { error: 'missing' }, 404);
    const b = fs.readFileSync(full);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] ?? 'application/octet-stream',
      'Content-Length': b.length,
      'Cache-Control': 'no-store',
    });
    res.end(b);
  } catch (e) {
    try { json(res, { error: String(e) }, 500); } catch { /* headers sent */ }
  }
});

// ================================ checks ====================================

const results = [];
let pageErrors = [];

function check(c, name, pass, note = '') {
  results.push({ c, name, pass: !!pass, note });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${c} · ${name}${note ? ` — ${note}` : ''}`);
}

// ================================ run =======================================

const browser = await launchBrowser();

try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));

  // ---- initial load + seed sessionMeta ------------------------------------
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('.sidebar .item', { timeout: 15000 });
  await sleep(500);

  // Inject sessionMeta then reload so stores read it at boot
  await page.evaluate((meta) => {
    localStorage.setItem('opencode.sessionMeta', JSON.stringify(meta));
  }, META);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sidebar .item', { timeout: 15000 });
  await sleep(800);

  // ======== S1 — sidebar toggle ============================================
  console.log('\nCASE S1 — sidebar toggle');
  const sidebarVisible = await page.locator('aside.sidebar').isVisible();
  check('S1', 'sidebar visible on load', sidebarVisible);

  // count sessions
  const initialCount = await page.locator('.sidebar .item').count();
  check('S1', 'all 5 sessions shown', initialCount === 5, `count=${initialCount}`);

  // click burger to close
  const burger = page.locator('button.burger[title="Toggle sidebar"]').first();
  if (await burger.isVisible()) {
    await burger.click();
    await sleep(500);
    const gone = !(await page.locator('aside.sidebar').isVisible().catch(() => false));
    check('S1', 'sidebar closes on burger click', gone);
    // reopen
    await burger.click();
    await sleep(500);
    const back = await page.locator('aside.sidebar').isVisible();
    check('S1', 'sidebar reopens on second burger click', back);
  } else {
    check('S1', 'burger button found', false, 'not visible');
  }

  // ======== T1 — tag chips on rows =========================================
  console.log('\nCASE T1 — tag chips render');
  const tagRow = page.locator('.sidebar .item .tagrow').first();
  await poll(async () => tagRow.isVisible(), 3000);
  check('T1', 'tag row visible on tagged session', await tagRow.isVisible());

  const ux2Tags = await page.locator('.sidebar .item', { hasText: 'Tagged with ux' })
    .locator('.tagspan').allTextContents();
  check('T1', 'ses_ux2 shows "ux" tag', ux2Tags.some((t) => t.includes('ux')), ux2Tags.join(','));

  const ux3Tags = await page.locator('.sidebar .item', { hasText: 'Multi-tagged' })
    .locator('.tagspan').allTextContents();
  check('T1', 'ses_ux3 shows "ux" + "backend"', ux3Tags.includes('ux') && ux3Tags.includes('backend'), ux3Tags.join(','));

  // ======== T2 — TagPopover opens, shows applied state =====================
  console.log('\nCASE T2 — TagPopover');
  await page.locator('.sidebar .item', { hasText: 'Tagged with ux' })
    .locator('.tagspan', { hasText: 'ux' }).click();
  await sleep(400);
  const popoverVisible = await page.locator('.tagpopover').isVisible();
  check('T2', 'TagPopover opens on tag click', popoverVisible);

  const uxApplied = await page.locator('.tagpopover .tagopt', { hasText: 'ux' })
    .evaluate((el) => el.classList.contains('applied'));
  check('T2', '"ux" shown as applied in popover', uxApplied);

  // close popover
  await page.keyboard.press('Escape');
  await sleep(200);

  // ======== T3 — create new tag ============================================
  console.log('\nCASE T3 — create new tag');
  // open popover on ses_ux3
  await page.locator('.sidebar .item', { hasText: 'Multi-tagged' })
    .locator('.tagspan', { hasText: 'ux' }).click();
  await sleep(400);
  await page.locator('.tagpopover .pnewtag input').fill('newtag');
  await page.keyboard.press('Enter');
  await sleep(400);

  const newApplied = await page.locator('.tagpopover .tagopt', { hasText: 'newtag' })
    .evaluate((el) => el.classList.contains('applied'));
  check('T3', 'new tag created and applied', newApplied);

  await page.keyboard.press('Escape');
  await sleep(300);
  const newTagOnRow = await page.locator('.sidebar .item', { hasText: 'Multi-tagged' })
    .locator('.tagspan', { hasText: 'newtag' }).isVisible();
  check('T3', 'new tag chip visible on row', newTagOnRow);

  // ======== T4 — remove tag ================================================
  console.log('\nCASE T4 — remove tag');
  // Open popover on ses_ux3's newtag chip, then click the applied tagopt to toggle off
  await page.locator('.sidebar .item', { hasText: 'Multi-tagged' })
    .locator('.tagspan', { hasText: 'newtag' }).click();
  await page.waitForSelector('.tagpopover', { timeout: 3000 });
  await page.locator('.tagpopover .tagopt', { hasText: 'newtag' }).click({ timeout: 3000 });
  await sleep(400);
  // "newtag" existed on no other session, so it vanishes from the popover list
  // entirely — the observable effect is the chip disappearing from the row.
  const chipGone = !(await page.locator('.sidebar .item', { hasText: 'Multi-tagged' })
    .locator('.tagspan', { hasText: 'newtag' }).count())
  check('T4', 'clicking applied tag removes it', chipGone);

  // ======== F1 — star display ==============================================
  console.log('\nCASE F1 — star display');
  const starredText = await page.locator('.sidebar .item', { hasText: 'Starred session' })
    .locator('.star').textContent();
  check('F1', 'starred session shows ★', starredText?.includes('★'), starredText);

  const plainText = await page.locator('.sidebar .item', { hasText: 'Plain session' })
    .locator('.star').textContent();
  check('F1', 'unstarred session shows ☆', plainText?.includes('☆'), plainText);

  // ======== F2 — star toggle ===============================================
  console.log('\nCASE F2 — star toggle');
  await page.locator('.sidebar .item', { hasText: 'Plain session' })
    .locator('.star').click();
  await sleep(300);
  const toggledText = await page.locator('.sidebar .item', { hasText: 'Plain session' })
    .locator('.star').textContent();
  check('F2', 'clicking ☆ stars the session', toggledText?.includes('★'), toggledText);

  const metaAfterStar = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('opencode.sessionMeta') || '{}')
  );
  const hasNewStar = Object.values(metaAfterStar).some((m) => m?.star);
  check('F2', 'star persisted to localStorage', hasNewStar);

  // unstar
  await page.locator('.sidebar .item', { hasText: 'Plain session' })
    .locator('.star').click();
  await sleep(300);
  const unstarredText = await page.locator('.sidebar .item', { hasText: 'Plain session' })
    .locator('.star').textContent();
  check('F2', 'clicking ★ unstars', unstarredText?.includes('☆'), unstarredText);

  // ======== F3 — folder button =============================================
  console.log('\nCASE F3 — folder display');
  const folderBtn = page.locator('.sidebar .item', { hasText: 'Archived session' })
    .locator('.folderbtn');
  const hasFoldered = await folderBtn.evaluate((el) => el.classList.contains('foldered'));
  check('F3', 'foldered session has .foldered class', hasFoldered);

  const plainFolder = page.locator('.sidebar .item', { hasText: 'Plain session' })
    .locator('.folderbtn');
  const plainFoldered = await plainFolder.evaluate((el) => el.classList.contains('foldered'));
  check('F3', 'non-foldered session lacks .foldered', !plainFoldered);

  // ======== F4 — folder picker opens, assign folder ========================
  console.log('\nCASE F4 — folder picker');
  await page.locator('.sidebar .item', { hasText: 'Plain session' })
    .locator('.folderbtn').click();
  await sleep(400);
  const pickerVisible = await page.locator('.folderpicker').isVisible();
  check('F4', 'folder picker opens', pickerVisible);

  const archiveOpt = page.locator('.folderpicker .fpopt', { hasText: 'archive' });
  check('F4', 'existing folders shown', await archiveOpt.isVisible());

  await archiveOpt.click();
  await sleep(400);
  const pickerClosed = !(await page.locator('.folderpicker').isVisible().catch(() => false));
  check('F4', 'picker closes after selection', pickerClosed);

  const plainFolderedAfter = await page.locator('.sidebar .item', { hasText: 'Plain session' })
    .locator('.folderbtn').evaluate((el) => el.classList.contains('foldered'));
  check('F4', 'session now has .foldered', plainFolderedAfter);

  // ======== F5 — create new folder =========================================
  console.log('\nCASE F5 — create new folder');
  await page.locator('.sidebar .item', { hasText: 'Starred session' })
    .locator('.folderbtn').click();
  await sleep(400);
  await page.locator('.folderpicker .fpnew input').fill('important');
  await page.keyboard.press('Enter');
  await sleep(400);
  const starredFoldered = await page.locator('.sidebar .item', { hasText: 'Starred session' })
    .locator('.folderbtn').evaluate((el) => el.classList.contains('foldered'));
  check('F5', 'new folder created and assigned', starredFoldered);

  // ======== F6 — remove folder =============================================
  console.log('\nCASE F6 — remove folder');
  await page.locator('.sidebar .item', { hasText: 'Starred session' })
    .locator('.folderbtn').click();
  await sleep(400);
  const clearBtn = page.locator('.folderpicker .fpopt', { hasText: 'Remove from folder' });
  check('F6', '"Remove from folder" option visible', await clearBtn.isVisible());
  await clearBtn.click();
  await sleep(400);
  const unfoldered = !(await page.locator('.sidebar .item', { hasText: 'Starred session' })
    .locator('.folderbtn').evaluate((el) => el.classList.contains('foldered')));
  check('F6', 'folder removed', unfoldered);

  // ======== R1 — filter bar visible ========================================
  console.log('\nCASE R1 — filter bar');
  const filterbar = page.locator('.filterbar');
  await poll(async () => filterbar.isVisible(), 3000);
  check('R1', 'filter bar visible (metadata exists)', await filterbar.isVisible());

  const chipCount = await page.locator('.filterchip').count();
  check('R1', 'filter chips rendered', chipCount >= 4, `count=${chipCount}`);

  // ======== R2 — filter bar hidden during search ===========================
  console.log('\nCASE R2 — filter bar hidden during search');
  await page.locator('#sidebar-search').fill('test query');
  await sleep(500);
  const filterHidden = !(await filterbar.isVisible().catch(() => false));
  check('R2', 'filter bar hidden during search', filterHidden);
  await page.locator('#sidebar-search').fill('');
  await page.keyboard.press('Escape');
  await sleep(400);

  // ======== R3 — star filter ===============================================
  console.log('\nCASE R3 — star filter');
  const starChip = page.locator('.filterchip').first();
  await starChip.click();
  await sleep(500);
  const starActive = await starChip.evaluate((el) => el.classList.contains('active'));
  check('R3', 'star chip activates', starActive);
  const starredRows = await page.locator('.sidebar .item').count();
  check('R3', 'only starred sessions shown', starredRows === 1, `count=${starredRows}`);
  await starChip.click(); // deselect
  await sleep(300);

  // ======== R4 — tag filter ================================================
  console.log('\nCASE R4 — tag filter');
  const uxChip = page.locator('.filterchip.tagchip', { hasText: 'ux' });
  await uxChip.click();
  await sleep(500);
  const uxActive = await uxChip.evaluate((el) => el.classList.contains('active'));
  check('R4', 'ux tag chip activates', uxActive);
  const uxRows = await page.locator('.sidebar .item').count();
  check('R4', '2 sessions with "ux" tag shown', uxRows === 2, `count=${uxRows}`);
  await uxChip.click(); // deselect
  await sleep(300);

  // ======== R5 — untagged filter ===========================================
  console.log('\nCASE R5 — untagged filter');
  const untaggedChip = page.locator('.filterchip.untaggedchip');
  await untaggedChip.click();
  await sleep(500);
  const untaggedActive = await untaggedChip.evaluate((el) => el.classList.contains('active'));
  check('R5', 'untagged chip activates', untaggedActive);
  const untaggedRows = await page.locator('.sidebar .item').count();
  // ses_ux1 (star, no tags), ses_ux4 (nothing), ses_ux5 (folder, no tags) = 3
  check('R5', '3 untagged sessions shown', untaggedRows === 3, `count=${untaggedRows}`);
  await untaggedChip.click(); // deselect
  await sleep(300);

  // ======== R6 — folder filter =============================================
  console.log('\nCASE R6 — folder filter');
  const projChip = page.locator('.filterchip.folderchip', { hasText: 'proj' });
  await projChip.click();
  await sleep(500);
  const projRows = await page.locator('.sidebar .item').count();
  check('R6', '1 session in "proj" folder shown', projRows === 1, `count=${projRows}`);
  await projChip.click(); // deselect
  await sleep(300);

  // ======== R7 — multi-filter AND ==========================================
  console.log('\nCASE R7 — multi-filter intersection');
  await starChip.click(); // star ON
  await sleep(200);
  await uxChip.click();   // ux tag ON
  await sleep(500);
  const multiRows = await page.locator('.sidebar .item').count();
  // ses_ux1 is starred but NOT tagged ux; ses_ux2/3 are tagged ux but NOT starred
  check('R7', 'star+tag AND = 0 (no overlap)', multiRows === 0, `count=${multiRows}`);
  await starChip.click(); // star OFF
  await uxChip.click();   // ux OFF
  await sleep(300);

  // ======== R8 — clear filters =============================================
  console.log('\nCASE R8 — clear filters');
  await starChip.click();
  await sleep(200);
  await untaggedChip.click();
  await sleep(300);
  const clearAll = page.locator('.filterclear');
  await poll(async () => clearAll.isVisible(), 1000);
  await clearAll.click();
  await sleep(500);
  const afterClear = await page.locator('.sidebar .item').count();
  check('R8', 'clear restores all sessions', afterClear === 5, `count=${afterClear}`);
  const starStillActive = await starChip.evaluate((el) => el.classList.contains('active'));
  check('R8', 'star chip deactivated after clear', !starStillActive);

  // ======== R9 — persistence across reload =================================
  console.log('\nCASE R9 — persistence');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sidebar .item', { timeout: 15000 });
  await sleep(800);

  const reloadedStarred = await page.locator('.sidebar .item', { hasText: 'Starred session' })
    .locator('.star').textContent();
  check('R9', 'star persists across reload', reloadedStarred?.includes('★'));

  const reloadedTags = await page.locator('.sidebar .item', { hasText: 'Multi-tagged' })
    .locator('.tagspan').allTextContents();
  check('R9', 'tags persist across reload', reloadedTags.includes('ux') && reloadedTags.includes('backend'));

  const reloadedFoldered = await page.locator('.sidebar .item', { hasText: 'Archived session' })
    .locator('.folderbtn').evaluate((el) => el.classList.contains('foldered'));
  check('R9', 'folder persists across reload', reloadedFoldered);

  const filterbarAfterReload = await page.locator('.filterbar').isVisible();
  check('R9', 'filter bar visible after reload', filterbarAfterReload);

  await screenshot(page, 'session-filters-final');
  await ctx.close();
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}

// =============================== summary ====================================

console.log('\n================ SUMMARY ================');
let fails = 0;
for (const r of results) {
  const tag = r.pass ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${r.name}${r.note ? ` — ${r.note}` : ''}`);
  if (!r.pass) fails++;
}
if (pageErrors.length) {
  console.log(`\npage errors observed (${pageErrors.length}):`);
  for (const e of [...new Set(pageErrors)].slice(0, 5)) console.log('  •', e.slice(0, 220));
}
console.log('\nChecks:', results.length, '| failed:', fails);
process.exitCode = fails ? 1 : 0;
