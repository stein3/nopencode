// session-filters.test.mjs — sidebar toggle, tag picker, stars, filters, migration
//
// Self-contained embedded test (same pattern as settings.test.mjs):
// serves webui/dist + stub /oc + fixture endpoints + SSE, driven via
// /__ctl and introspected via /__state.
//
// Server-backed meta flow: session stars/tags live in server-side storage
// (session_meta in fake server). The webui client:
//   - Hydrates sessionMeta store from localStorage at boot (instant paint)
//   - On sidebar session-list load, calls applyServerMeta(sessions) which
//     REPLACES the store with data from GET /api/history/sessions
//   - A one-time migration pushes localStorage-only meta to the server
//     (flag: opencode.sessionMetaMigrated)
//   - toggleStar/setTag fire PUT /api/history/session/{sid}/meta
//   - dropSessionMeta fires DELETE /api/history/session/{sid}/meta
//
// Checks:
//   S1  sidebar visible on load; burger button toggles it closed/reopen
//   T1  tag button shows .tagged class for tagged sessions, plain for untagged
//   T2  clicking tag button opens tag picker; current tag shown as .current
//   T3  creating a new tag via picker input persists on the row
//   T4  "Remove tag" clears the tag assignment
//   T5  clicking outside the picker closes it
//   T6  pressing Escape closes the picker
//   F1  star button shows ★ for starred, ☆ for unstarred
//   F2  clicking star toggles star state + persists to server (verified via /api/history/sessions)
//   R1  filter bar visible when metadata exists (stars/tags)
//   R2  filter bar hidden when search query is active
//   R3  star filter shows only starred sessions
//   R4  tag filter shows only sessions with that tag
//   R5  untagged filter shows only sessions without tags
//   R6  tag filter (proj) shows only sessions tagged proj
//   R7  multi-filter (star + tag) is OR union
//   R8  clear button deactivates all filters and restores full list
//   R9  tags/star persist across page reload (proven by clearing localStorage — server is source of truth)
//   M1  legacy migration: folder/tags keys migrate to server via PUT meta on load
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
  { id: 'ses_ux3', title: 'Tagged in proj',      created: NOW - 300_000, updated: NOW - 80_000,  message_count: 3, cost: 0 },
  { id: 'ses_ux4', title: 'Plain session',       created: NOW - 200_000, updated: NOW - 70_000,  message_count: 1, cost: 0 },
  { id: 'ses_ux5', title: 'Archived session',    created: NOW - 100_000, updated: NOW - 60_000,  message_count: 2, cost: 0 },
];

// sessionMeta seeded into localStorage after first load
const META = {
  ses_ux1: { star: true },
  ses_ux2: { tag: 'ux' },
  ses_ux3: { tag: 'proj' },
  ses_ux4: {},
  ses_ux5: { tag: 'archive' },
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

// server-backed session meta (star/tag) — mirrors chatserver smeta table
const session_meta = {};

// seed server-side meta (matches the META fixture)
for (const [sid, m] of Object.entries(META)) {
  if (m.star || m.tag) session_meta[sid] = { star: !!m.star, tag: m.tag ?? null };
}

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
      if (body.clearMeta) {
        for (const k of Object.keys(session_meta)) delete session_meta[k];
      }
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
    if (p === '/api/history/sessions') {
      const withMeta = SESSIONS.map(s => {
        const m = session_meta[s.id];
        return m ? { ...s, ...(m.star && { star: true }), ...(m.tag && { tag: m.tag }) } : s;
      });
      return json(res, withMeta);
    }
    // session meta (star/tag) — PUT partial merge, DELETE clear
    const mMeta = p.match(/^\/api\/history\/session\/([^/]+)\/meta$/);
    if (mMeta) {
      const sid = mMeta[1];
      if (req.method === 'PUT' || req.method === 'POST') {
        try {
          const body = JSON.parse((await readBody(req)) || '{}');
          const cur = session_meta[sid] || { star: false, tag: null };
          if ('star' in body) cur.star = !!body.star;
          if ('tag' in body) cur.tag = body.tag || null;
          // clean up empty entries
          if (!cur.star && !cur.tag) delete session_meta[sid];
          else session_meta[sid] = cur;
          return json(res, { ok: true, star: !!cur.star, tag: cur.tag });
        } catch { return json(res, { error: 'bad json' }, 400); }
      }
      if (req.method === 'DELETE') {
        delete session_meta[sid];
        return json(res, { ok: true });
      }
      // GET
      const cur = session_meta[sid];
      return json(res, cur || { star: false, tag: null });
    }
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

  // Seed localStorage boot cache + set migration flag so applyServerMeta
  // doesn't try to re-push (server already has the meta from our seed)
  await page.evaluate((meta) => {
    localStorage.setItem('opencode.sessionMeta', JSON.stringify(meta));
    localStorage.setItem('opencode.sessionMetaMigrated', '1');
  }, META);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sidebar .item', { timeout: 15000 });
  await sleep(800);

  // ======== S1 — sidebar toggle ============================================
  console.log('\nCASE S1 — sidebar toggle');
  const sidebarVisible = await page.locator('aside.sidebar').isVisible();
  check('S1', 'sidebar visible on load', sidebarVisible);

  const initialCount = await page.locator('.sidebar .item').count();
  check('S1', 'all 5 sessions shown', initialCount === 5, `count=${initialCount}`);

  const burger = page.locator('button.burger[title="Toggle sidebar"]').first();
  if (await burger.isVisible()) {
    await burger.click();
    await sleep(500);
    const gone = !(await page.locator('aside.sidebar').isVisible().catch(() => false));
    check('S1', 'sidebar closes on burger click', gone);
    await burger.click();
    await sleep(500);
    const back = await page.locator('aside.sidebar').isVisible();
    check('S1', 'sidebar reopens on second burger click', back);
  } else {
    check('S1', 'burger button found', false, 'not visible');
  }

  // ======== T1 — tag button display ========================================
  console.log('\nCASE T1 — tag button display');
  const taggedBtn = page.locator('.sidebar .item', { hasText: 'Tagged with ux' })
    .locator('.tagbtn');
  const hasTagged = await taggedBtn.evaluate((el) => el.classList.contains('tagged'));
  check('T1', 'tagged session has .tagged class', hasTagged);

  const plainBtn = page.locator('.sidebar .item', { hasText: 'Plain session' })
    .locator('.tagbtn');
  const plainTagged = await plainBtn.evaluate((el) => el.classList.contains('tagged'));
  check('T1', 'untagged session lacks .tagged', !plainTagged);

  // ======== T2 — tag picker opens, current tag shown =======================
  console.log('\nCASE T2 — tag picker');
  await page.locator('.sidebar .item', { hasText: 'Tagged with ux' })
    .locator('.tagbtn').click();
  await sleep(400);
  const pickerVisible = await page.locator('.tagpicker').isVisible();
  check('T2', 'tag picker opens', pickerVisible);

  const currentOpt = page.locator('.tagpicker .tpopt.current');
  const currentText = await currentOpt.textContent();
  check('T2', 'current tag highlighted as .current', currentText?.includes('ux'), currentText);

  // close picker
  await page.keyboard.press('Escape');
  await sleep(200);

  // ======== T3 — create new tag via picker =================================
  console.log('\nCASE T3 — create new tag');
  await page.locator('.sidebar .item', { hasText: 'Plain session' })
    .locator('.tagbtn').click();
  await sleep(400);
  await page.locator('.tagpicker .tpnew input').fill('newtag');
  await page.keyboard.press('Enter');
  await sleep(400);
  const pickerClosed = !(await page.locator('.tagpicker').isVisible().catch(() => false));
  check('T3', 'picker closes after creation', pickerClosed);

  const plainTaggedAfter = await page.locator('.sidebar .item', { hasText: 'Plain session' })
    .locator('.tagbtn').evaluate((el) => el.classList.contains('tagged'));
  check('T3', 'session now has .tagged', plainTaggedAfter);

  // ======== T4 — remove tag ================================================
  console.log('\nCASE T4 — remove tag');
  await page.locator('.sidebar .item', { hasText: 'Plain session' })
    .locator('.tagbtn').click();
  await sleep(400);
  const removeBtn = page.locator('.tagpicker .tpopt', { hasText: 'Remove tag' });
  check('T4', '"Remove tag" option visible', await removeBtn.isVisible());
  await removeBtn.click();
  await sleep(400);
  const untagged = !(await page.locator('.sidebar .item', { hasText: 'Plain session' })
    .locator('.tagbtn').evaluate((el) => el.classList.contains('tagged')));
  check('T4', 'tag removed', untagged);

  // ======== T5 — click outside closes picker ===============================
  console.log('\nCASE T5 — click outside closes picker');
  await page.locator('.sidebar .item', { hasText: 'Tagged with ux' })
    .locator('.tagbtn').click();
  await sleep(400);
  const openBefore = await page.locator('.tagpicker').isVisible();
  check('T5', 'picker opened', openBefore);
  // click on the sidebar legend (outside picker + outside tagbtn)
  await page.locator('.legend').click();
  await sleep(300);
  const closedAfter = !(await page.locator('.tagpicker').isVisible().catch(() => false));
  check('T5', 'picker closed after outside click', closedAfter);

  // ======== T6 — Escape closes picker ======================================
  console.log('\nCASE T6 — Escape closes picker');
  await page.locator('.sidebar .item', { hasText: 'Tagged with ux' })
    .locator('.tagbtn').click();
  await sleep(400);
  const openForEsc = await page.locator('.tagpicker').isVisible();
  check('T6', 'picker opened for Escape test', openForEsc);
  await page.keyboard.press('Escape');
  await sleep(300);
  const closedAfterEsc = !(await page.locator('.tagpicker').isVisible().catch(() => false));
  check('T6', 'picker closed after Escape', closedAfterEsc);

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

  // star persisted to server (fake server meta state)
  const sessionsAfterStar = await page.evaluate(() => fetch('/api/history/sessions').then(r => r.json()));
  const plainAfterStar = sessionsAfterStar.find(s => s.id === 'ses_ux4');
  check('F2', 'star persisted to server', plainAfterStar?.star === true);

  // unstar
  await page.locator('.sidebar .item', { hasText: 'Plain session' })
    .locator('.star').click();
  await sleep(300);
  const unstarredText = await page.locator('.sidebar .item', { hasText: 'Plain session' })
    .locator('.star').textContent();
  check('F2', 'clicking ★ unstars', unstarredText?.includes('☆'), unstarredText);

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

  // ======== R4 — tag filter (ux) ===========================================
  console.log('\nCASE R4 — tag filter');
  const uxChip = page.locator('.filterchip.tagchip', { hasText: 'ux' });
  await uxChip.click();
  await sleep(500);
  const uxActive = await uxChip.evaluate((el) => el.classList.contains('active'));
  check('R4', 'ux tag chip activates', uxActive);
  const uxRows = await page.locator('.sidebar .item').count();
  check('R4', '1 session with "ux" tag shown', uxRows === 1, `count=${uxRows}`);
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
  // ses_ux1 (star, no tag) + ses_ux4 (nothing) = 2 untagged
  check('R5', '2 untagged sessions shown', untaggedRows === 2, `count=${untaggedRows}`);
  await untaggedChip.click(); // deselect
  await sleep(300);

  // ======== R6 — tag filter (proj) =========================================
  console.log('\nCASE R6 — tag filter (proj)');
  const projChip = page.locator('.filterchip.tagchip', { hasText: 'proj' });
  await projChip.click();
  await sleep(500);
  const projRows = await page.locator('.sidebar .item').count();
  check('R6', '1 session with "proj" tag shown', projRows === 1, `count=${projRows}`);
  await projChip.click(); // deselect
  await sleep(300);

  // ======== R7 — multi-filter OR ===========================================
  console.log('\nCASE R7 — multi-filter union (OR)');
  await starChip.click(); // star ON
  await sleep(200);
  await uxChip.click();   // ux tag ON
  await sleep(500);
  const multiRows = await page.locator('.sidebar .item').count();
  // OR union: ses_ux1 (starred) + ses_ux2 (tagged ux) = 2
  check('R7', 'star+tag OR = union of both', multiRows === 2, `count=${multiRows}`);
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
  // Clear localStorage to prove server is the source of truth
  await page.evaluate(() => {
    localStorage.removeItem('opencode.sessionMeta');
    localStorage.removeItem('opencode.sessionMetaMigrated');
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sidebar .item', { timeout: 15000 });
  await sleep(800);

  const reloadedStarred = await page.locator('.sidebar .item', { hasText: 'Starred session' })
    .locator('.star').textContent();
  check('R9', 'star persists across reload', reloadedStarred?.includes('★'));

  const reloadedTagged = await page.locator('.sidebar .item', { hasText: 'Tagged with ux' })
    .locator('.tagbtn').evaluate((el) => el.classList.contains('tagged'));
  check('R9', 'tag persists across reload', reloadedTagged);

  const filterbarAfterReload = await page.locator('.filterbar').isVisible();
  check('R9', 'filter bar visible after reload', filterbarAfterReload);

  // ======== M1 — legacy migration ==========================================
  console.log('\nCASE M1 — legacy migration');
  // Reset server state and clear migration flag so legacy localStorage is pushed
  await page.evaluate(() => {
    localStorage.removeItem('opencode.sessionMetaMigrated');
  });
  // Clear server meta via the fake state (we need a helper — use the __ctl endpoint)
  await page.evaluate(() => fetch('/__ctl', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clearMeta: true }),
  }));
  // Set legacy shape: folder wins over tags[0]
  await page.evaluate(() => {
    localStorage.setItem('opencode.sessionMeta', JSON.stringify({
      ses_ux2: { tags: ['ux', 'backend'] },
      ses_ux3: { tags: ['x'], folder: 'proj' },
      ses_ux1: { star: true },
    }));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sidebar .item', { timeout: 15000 });
  await sleep(800);

  // ses_ux2: tags[0] = 'ux' (no folder) → tag = 'ux'
  const ux2Tagged = await page.locator('.sidebar .item', { hasText: 'Tagged with ux' })
    .locator('.tagbtn').evaluate((el) => el.classList.contains('tagged'));
  check('M1', 'ses_ux2 shows tagged (from tags[0])', ux2Tagged);

  // ses_ux3: folder='proj' wins over tags[0]='x' → tag = 'proj'
  const ux3Tagged = await page.locator('.sidebar .item', { hasText: 'Tagged in proj' })
    .locator('.tagbtn').evaluate((el) => el.classList.contains('tagged'));
  check('M1', 'ses_ux3 shows tagged (folder wins)', ux3Tagged);

  // localStorage no longer contains 'folder' or 'tags' keys
  const migrated = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('opencode.sessionMeta') || '{}')
  );
  const noLegacy = Object.values(migrated).every((v) => !v.folder && !v.tags);
  check('M1', 'localStorage has no folder/tags keys after migration', noLegacy,
    JSON.stringify(Object.keys(migrated).map((k) => ({ k, ...migrated[k] }))));

  // ses_ux1 still starred
  const ux1Star = await page.locator('.sidebar .item', { hasText: 'Starred session' })
    .locator('.star').textContent();
  check('M1', 'ses_ux1 star preserved after migration', ux1Star?.includes('★'));

  // Verify server received the migrated values
  const metaAfterM1 = await page.evaluate(() => fetch('/api/history/sessions').then(r => r.json()));
  const ux2After = metaAfterM1.find(s => s.id === 'ses_ux2');
  check('M1', 'server received migrated tag (ux from tags[0])', ux2After?.tag === 'ux');
  const ux3After = metaAfterM1.find(s => s.id === 'ses_ux3');
  check('M1', 'server received migrated tag (proj from folder)', ux3After?.tag === 'proj');

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
