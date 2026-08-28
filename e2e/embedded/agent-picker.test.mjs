// agent-picker.test.mjs — merged embedded test for the webui AgentPicker
// (per-message role dropdown). Combines coverage from the two integration
// tests (agent-picker + agentpicker) into a single self-contained fake-engine
// test on port 8144.
//
// Cases:
//   1. Fresh state: collapsed label "Auto", no persisted agent
//   2. Menu roster: eligible agents only, Auto first, no subagent/hidden leakage
//   3. Menu UX: opens upward, Esc closes, click-outside closes, selection marked
//   4. Pick Plan → label + payload carries agent:"plan" + model present
//   5. Auto row resets label + clears localStorage
//   6. Back to Plan → current selection marked in menu
//   7. Sticky across reload (label persists)
//   8. Per-session isolation: second tab starts Auto despite A=Plan
//   9. Pending tab pick survives realize (rekey migration), label + payload
//  10. Per-session localStorage map (A=plan, B=build)
//  11. Switch tabs restores session A's own pick
//  12. Auto on A doesn't affect B
//  13. Auto omits the agent field entirely
//  14. Mobile (360px): compact picker, menu fits viewport
//
// Run: node e2e/embedded/agent-picker.test.mjs

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, launchBrowser, screenshot, SHOTS_DIR, sleep, poll } from '../helpers/setup.mjs';

const PORT = 8144;
const BASE = `http://127.0.0.1:${PORT}`;

const AGENT_ROSTER = [
  { name: 'Orchestrator', mode: 'primary', hidden: false },
  { name: 'Build', mode: 'primary', hidden: false },
  { name: 'Plan', mode: 'primary', hidden: false },
  { name: 'Compaction', mode: 'subagent', hidden: true },
  { name: 'Title', mode: 'subagent', hidden: true },
  { name: 'Summary', mode: 'subagent', hidden: true },
];

const SEED_SID = 'ses_apseed0';
const SEED_MSG_ID = 'msg_apseed0';

// ============================== fake engine =================================

const state = {
  sessionCount: 0,
  sessions: {
    [SEED_SID]: { id: SEED_SID, title: 'agent-picker-probe' },
  },
  messages: {
    [SEED_SID]: [
      {
        info: {
          id: SEED_MSG_ID,
          role: 'user',
          time: { created: Date.now() - 60_000 },
        },
        parts: [{ id: 'part_s1', type: 'text', text: 'hello agent picker seed' }],
      },
    ],
  },
  counts: {},
};
const sseClients = new Set();

function sseEmit(type, properties = {}) {
  const frame = `data: ${JSON.stringify({ type, properties })}\n\n`;
  for (const res of sseClients) {
    try { res.write(frame); } catch { /* dropped */ }
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain',
};

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => resolve(buf));
  });
}

function json(res, obj, code = 200) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': b.length,
  });
  res.end(b);
}

const server = http.createServer(async (req, res) => {
  const p = (req.path_url ??= req.url.split('?')[0]);
  state.counts[p] = (state.counts[p] ?? 0) + 1;

  try {
    // ---- test introspection + control ----------------------------------------
    if (p === '/__state') {
      return json(res, {
        sessions: state.sessions,
        sessionCount: state.sessionCount,
        counts: state.counts,
      });
    }
    if (p === '/__ctl') {
      const ctl = JSON.parse((await readBody(req)) || '{}');
      if (ctl.emit) sseEmit(ctl.emit.type, ctl.emit.properties ?? {});
      return json(res, { ok: true });
    }

    // ---- SSE -----------------------------------------------------------------
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

    // ---- agent roster --------------------------------------------------------
    if (p === '/oc/agent') return json(res, AGENT_ROSTER);

    // ---- config / providers --------------------------------------------------
    if (p === '/oc/config/providers')
      return json(res, {
        providers: [
          {
            id: 'opencode',
            models: {
              'x-preview-f-free': { id: 'x-preview-f-free' },
              'ox-alpha-free': { id: 'ox-alpha-free' },
            },
          },
        ],
      });

    if (p === '/oc/path') return json(res, { directory: '/workspace' });
    if (p === '/oc/mcp') return json(res, {});
    if (p === '/oc/question') return json(res, []);

    // ---- history (chatserver stubs) ------------------------------------------
    if (p === '/api/history/sessions') {
      const list = [
        {
          id: SEED_SID,
          title: 'agent-picker-probe',
          created: Date.now() - 120_000,
          updated: Date.now() - 30_000,
          message_count: 1,
          cost: 0,
        },
        ...Object.values(state.sessions)
          .filter((s) => s.id !== SEED_SID)
          .map((s) => ({
            id: s.id,
            title: s.title,
            created: Date.now() - 120_000,
            updated: Date.now() - 30_000,
            message_count: 0,
            cost: 0,
          })),
      ];
      return json(res, list);
    }
    if (p.endsWith('/errors')) {
      if (req.method === 'GET') return json(res, []);
      return json(res, { ok: true });
    }
    if (p.startsWith('/api/history/session/')) return json(res, []);

    // ---- engine stubs --------------------------------------------------------
    if (p === '/oc/session/status') return json(res, {});

    // POST /oc/session — create session
    if (p === '/oc/session' && req.method === 'POST') {
      state.sessionCount++;
      const id = `ses_ap${state.sessionCount}`;
      const body = JSON.parse((await readBody(req)) || '{}');
      const title = body.title || `agent-picker-probe-${state.sessionCount}`;
      state.sessions[id] = { id, title };
      state.messages[id] = [];
      return json(res, { id, title, revert: null });
    }

    // PATCH /oc/session/* — session update (noop)
    const mPatch = p.match(/^\/oc\/session\/([^/]+)$/);
    if (mPatch && req.method === 'PATCH') {
      const sid = mPatch[1];
      const body = JSON.parse((await readBody(req)) || '{}');
      if (state.sessions[sid] && body.title) state.sessions[sid].title = body.title;
      return json(res, { ok: true });
    }

    // DELETE /oc/session/* — cleanup
    const mDel = p.match(/^\/oc\/session\/([^/]+)$/);
    if (mDel && req.method === 'DELETE') {
      delete state.sessions[mDel[1]];
      return json(res, { ok: true });
    }

    // GET /oc/session/* — session info
    const mGet = p.match(/^\/oc\/session\/([^/]+)$/);
    if (mGet && req.method === 'GET') {
      const sid = mGet[1];
      const s = state.sessions[sid];
      if (!s) return json(res, { error: 'not found' }, 404);
      return json(res, { id: s.id, title: s.title, revert: null });
    }

    // GET /oc/session/*/message — messages for session
    const mMsg = p.match(/^\/oc\/session\/([^/]+)\/message$/);
    if (mMsg && req.method === 'GET') {
      return json(res, state.messages[mMsg[1]] ?? []);
    }

    // POST /oc/session/*/prompt_async — intercept + 204
    const mPrompt = p.match(/^\/oc\/session\/([^/]+)\/prompt_async$/);
    if (mPrompt && req.method === 'POST') {
      return res.writeHead(204, { 'Content-Length': 0 }).end();
    }

    // POST /oc/session/*/message — noop
    if (p.match(/^\/oc\/session\/[^/]+\/message$/) && req.method === 'POST') {
      return json(res, { ok: true });
    }

    if (p.startsWith('/oc/')) return json(res, []);

    // ---- statics (webui/dist) -----------------------------------------------
    const rel = p === '/' ? '/index.html' : p;
    const full = fs.realpathSync(path.join(DIST, rel));
    if (!full.startsWith(fs.realpathSync(DIST)) || !fs.statSync(full).isFile())
      return json(res, { error: 'missing' }, 404);
    const ct = MIME[path.extname(full)] ?? 'application/octet-stream';
    const b = fs.readFileSync(full);
    res.writeHead(200, {
      'Content-Type': ct,
      'Content-Length': b.length,
      'Cache-Control': 'no-store',
    });
    res.end(b);
  } catch (e) {
    try { json(res, { error: String(e) }, 500); } catch { /* SSE */ }
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

const PANE = '.tabpane[style*="flex"]';
const trigger = () => page.locator(`${PANE} .toolbar .wrap:first-child button.cur`);
const menuRows = () => page.locator(`${PANE} .toolbar .wrap:first-child .menu button.m`);
const activeSid = () => page.locator('.tabbar .tab.active').getAttribute('data-sid');
const gotoTab = async (sid) => {
  await page.locator(`.tabbar .tab[data-sid="${sid}"]`).click();
  await sleep(300);
};

const titleName = (s) =>
  s.replace(/(^|[\s-])(\w)/g, (_s, sep, ch) => sep + ch.toUpperCase());

// expected eligible roster from the fake engine
const expectedEligible = AGENT_ROSTER
  .filter((a) => a.mode !== 'subagent' && !a.hidden)
  .map((a) => titleName(a.name));
// expected full menu = Auto + eligible (in roster order)
const expectedMenu = ['Auto', ...expectedEligible];

let page;
const sessionIds = new Set();

try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log(`fake engine listening on ${BASE}`);

  const browser = await launchBrowser();
  page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => pageErrors.push(e.message));

  // --- intercept prompt_async payloads ---------------------------------------
  const bodies = [];
  await page.route('**/oc/session/*/prompt_async', (route) => {
    if (route.request().method() === 'POST') {
      try { bodies.push(JSON.parse(route.request().postData() ?? '{}')); } catch {}
      return route.fulfill({ status: 204, body: '' });
    }
    return route.fallback();
  });

  // --- intercept POST /oc/session to track created session IDs ----------------
  let createdSid = '';
  await page.route('**/oc/session', async (route) => {
    const r = route.request();
    if (r.method() === 'POST' && !r.url().endsWith('/session/')) {
      const resp = await route.fetch();
      try {
        const body = JSON.parse(await resp.text());
        if (body?.id) {
          createdSid = body.id;
          sessionIds.add(body.id);
        }
        return route.fulfill({ response: resp, body: JSON.stringify(body) });
      } catch {
        return route.fulfill({ response: resp, body: await resp.text() });
      }
    }
    return route.fallback();
  });

  // send helper — scoped to active pane
  const send = async (text) => {
    const ta = page.locator(`${PANE} #composer-input:visible`);
    await ta.fill(text);
    await ta.press('Enter');
    await sleep(600);
  };

  // ---- load page + fresh state ----------------------------------------------
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await sleep(2500);

  await page.evaluate(() => {
    localStorage.removeItem('opencode.agent');
    localStorage.removeItem('opencode.sessionAgents');
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(2500);

  try {

  // ====================================================================
  // CASE 1 — fresh state: collapsed label "Auto"
  // ====================================================================
  console.log('\nCASE 1 — fresh state');
  await trigger().waitFor({ state: 'visible', timeout: 5000 });
  check(
    '1.1', 'collapsed label defaults to "Auto"',
    ((await trigger().textContent()) ?? '').includes('Auto'),
  );

  // ====================================================================
  // CASE 2 — menu roster: eligible agents only, Auto first
  // ====================================================================
  console.log('\nCASE 2 — menu roster');
  await trigger().click();
  await page.waitForSelector(`${PANE} .toolbar .wrap:first-child .menu button.m`);
  const names = [];
  for (const r of await menuRows().all()) {
    const nm = ((await r.locator('.nm').textContent()) ?? '').trim();
    names.push(nm);
  }

  check(
    '2.1', 'all eligible agents present (no missing)',
    expectedEligible.every((e) => names.includes(e)),
    `expected=${JSON.stringify(expectedEligible)} got=${JSON.stringify(names.filter((n) => n !== 'Auto'))}`,
  );
  check(
    '2.2', 'no subagent/hidden leakage',
    names.filter((n) => n !== 'Auto' && !expectedEligible.includes(n)).length === 0,
  );
  check('2.3', 'Auto row pinned first', names[0] === 'Auto');
  check(
    '2.4', 'menu order matches roster (Auto first, then eligible)',
    JSON.stringify(names) === JSON.stringify(expectedMenu),
    `got=${JSON.stringify(names)}`,
  );

  // ====================================================================
  // CASE 3 — menu UX: upward, Esc, click-outside, selection marked
  // ====================================================================
  console.log('\nCASE 3 — menu UX');

  // upward: menu opens above the button
  const bb = await trigger().boundingBox();
  const mb = await page.locator(`${PANE} .toolbar .wrap:first-child .menu`).boundingBox();
  check(
    '3.1', 'menu opens upward above button',
    bb && mb && mb.y + mb.height <= bb.y + 2,
    `menu bottom=${mb ? Math.round(mb.y + mb.height) : '?'}, btn top=${bb ? Math.round(bb.y) : '?'}`,
  );

  // Esc closes
  await page.keyboard.press('Escape');
  await sleep(150);
  check('3.2', 'Escape closes menu', (await page.locator(`${PANE} .toolbar .wrap:first-child .menu`).count()) === 0);

  // click-outside closes
  await trigger().click();
  await page.waitForSelector(`${PANE} .toolbar .wrap:first-child .menu button.m`);
  await page.locator(`${PANE} #composer-input`).click();
  await sleep(150);
  check('3.3', 'click-outside closes menu', (await page.locator(`${PANE} .toolbar .wrap:first-child .menu`).count()) === 0);

  // ====================================================================
  // CASE 4 — pick Plan → label + payload
  // ====================================================================
  console.log('\nCASE 4 — pick Plan');
  await trigger().click();
  await page.waitForSelector(`${PANE} .toolbar .wrap:first-child .menu button.m`);

  const planRow = page.locator(`${PANE} .toolbar .wrap:first-child .menu button.m`, { hasText: 'Plan' });
  check('4.1', 'exactly one Plan row', (await planRow.count()) === 1);
  await planRow.click();
  check(
    '4.2', 'collapsed label updates to "Plan"',
    ((await trigger().textContent()) ?? '').includes('Plan'),
  );

  // current selection marked in menu
  await trigger().click();
  await page.waitForSelector(`${PANE} .toolbar .wrap:first-child .menu button.m`);
  const onRow = await page.locator(`${PANE} .toolbar .wrap:first-child .menu .m.on .nm`).allTextContents();
  check(
    '4.3', 'current selection marked in menu',
    onRow.map((s) => s.trim()).includes('Plan'),
    `onRows=${JSON.stringify(onRow)}`,
  );
  await page.keyboard.press('Escape');
  await sleep(100);

  // send → payload
  await send('agent picker probe one');
  check('4.4', 'prompt_async intercepted', bodies.length >= 1);
  const b1 = bodies[bodies.length - 1];
  check('4.5', 'payload carries agent:"Plan"', b1?.agent === 'Plan', `got=${JSON.stringify(b1?.agent)}`);
  check(
    '4.6', 'payload model present',
    !!b1?.model?.providerID && !!b1?.model?.modelID,
    `${b1?.model?.providerID}/${b1?.model?.modelID}`,
  );
  check('4.7', 'payload text intact', b1?.parts?.[0]?.text === 'agent picker probe one');

  // ====================================================================
  // CASE 5 — Auto row resets label + clears localStorage
  // ====================================================================
  console.log('\nCASE 5 — Auto resets');
  await trigger().click();
  await page.waitForSelector(`${PANE} .toolbar .wrap:first-child .menu button.m`);
  await page.locator(`${PANE} .toolbar .wrap:first-child .menu button.m.auto`).click();
  await sleep(150);
  check('5.1', 'label back to Auto', ((await trigger().textContent()) ?? '').includes('Auto'));
  const afterAuto = await page.evaluate(() => localStorage.getItem('opencode.sessionAgents'));
  check(
    '5.2', 'localStorage cleared on Auto',
    afterAuto === '{}' || afterAuto === null,
    `got=${afterAuto}`,
  );

  // ====================================================================
  // CASE 6 — back to Plan → persistence + localStorage shape
  // ====================================================================
  console.log('\nCASE 6 — persistence');
  await trigger().click();
  await page.waitForSelector(`${PANE} .toolbar .wrap:first-child .menu button.m`);
  await page.locator(`${PANE} .toolbar .wrap:first-child .menu button.m`, { hasText: 'Plan' }).first().click();
  await sleep(150);
  check('6.1', 'label shows Plan', ((await trigger().textContent()) ?? '').includes('Plan'));
  const storedRaw = await page.evaluate(() => localStorage.getItem('opencode.sessionAgents'));
  let storedOk = false;
  try {
    const map = JSON.parse(storedRaw ?? '{}');
    const keys = Object.keys(map);
    storedOk = keys.length === 1 && map[keys[0]] === 'Plan' && !!keys[0];
  } catch {}
  check('6.2', 'localStorage single per-session entry', storedOk, `got=${storedRaw}`);

  // ====================================================================
  // CASE 7 — sticky across reload
  // ====================================================================
  console.log('\nCASE 7 — sticky across reload');
  const sidA = await activeSid();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(1500);
  if ((await activeSid()) !== sidA && sidA) await gotoTab(sidA);
  check(
    '7.1', 'label persists across reload',
    ((await trigger().textContent()) ?? '').includes('Plan'),
  );
  await send('agent picker probe two');
  const b2 = bodies[bodies.length - 1];
  check('7.2', 'second send still carries agent:"Plan"', b2?.agent === 'Plan');

  // ====================================================================
  // CASE 8 — per-session isolation: new tab starts Auto
  // ====================================================================
  console.log('\nCASE 8 — per-session isolation');
  await page.click('button.add');
  await sleep(500);
  check(
    '8.1', 'new session starts Auto (no leak from session A)',
    ((await trigger().textContent()) ?? '').includes('Auto'),
  );

  // ====================================================================
  // CASE 9 — pending tab: pick Build → realize → label + payload
  // ====================================================================
  console.log('\nCASE 9 — pending tab realize');
  await trigger().click();
  await page.waitForSelector(`${PANE} .toolbar .wrap:first-child .menu button.m`);
  const buildRow = page.locator(`${PANE} .toolbar .wrap:first-child .menu button.m`, { hasText: 'Build' });
  check('9.1', 'exactly one Build row', (await buildRow.count()) === 1);
  await buildRow.click();
  check(
    '9.2', 'pending tab label updates to "Build"',
    ((await trigger().textContent()) ?? '').includes('Build'),
  );

  await send('agent picker probe three');
  const b3 = bodies[bodies.length - 1];
  check('9.3', 'pending tab realized', !!createdSid, `createdSid=${createdSid}`);
  check('9.4', 'post-realize send carries agent:"Build"', b3?.agent === 'Build');
  check(
    '9.5', 'label still "Build" after realize',
    ((await trigger().textContent()) ?? '').includes('Build'),
  );

  // ====================================================================
  // CASE 10 — per-session localStorage map
  // ====================================================================
  console.log('\nCASE 10 — localStorage map');
  const storedMap = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('opencode.sessionAgents') ?? '{}'),
  );
  check(
    '10.1', 'localStorage has per-session entries (A=plan, B=build)',
    storedMap[sidA] === 'Plan' && storedMap[createdSid] === 'Build',
    `map=${JSON.stringify(storedMap)}`,
  );

  // ====================================================================
  // CASE 11 — switch tabs restores session A's pick
  // ====================================================================
  console.log('\nCASE 11 — switch tabs');
  if (sidA) await gotoTab(sidA);
  check(
    '11.1', 'switching tabs restores session A pick (Plan)',
    ((await trigger().textContent()) ?? '').includes('Plan'),
  );

  // ====================================================================
  // CASE 12 — Auto on A doesn't affect B
  // ====================================================================
  console.log('\nCASE 12 — cross-session isolation');
  await trigger().click();
  await page.waitForSelector(`${PANE} .toolbar .wrap:first-child .menu button.m`);
  await page.locator(`${PANE} .toolbar .wrap:first-child .menu button.m.auto`).click();
  check('12.1', 'back to Auto on A', ((await trigger().textContent()) ?? '').includes('Auto'));
  await gotoTab(createdSid);
  check(
    '12.2', 'session B unaffected by A going Auto (still Build)',
    ((await trigger().textContent()) ?? '').includes('Build'),
  );
  await send('agent picker probe four');
  const b4 = bodies[bodies.length - 1];
  check('12.3', 'send from B still carries agent:"Build"', b4?.agent === 'Build');

  // ====================================================================
  // CASE 13 — Auto omits the agent field
  // ====================================================================
  console.log('\nCASE 13 — Auto omits agent field');
  await trigger().click();
  await page.waitForSelector(`${PANE} .toolbar .wrap:first-child .menu button.m`);
  await page.locator(`${PANE} .toolbar .wrap:first-child .menu button.m.auto`).click();
  check('13.1', 'B back to Auto', ((await trigger().textContent()) ?? '').includes('Auto'));
  await send('agent picker probe five');
  const b5 = bodies[bodies.length - 1];
  check('13.2', 'Auto send omits agent field entirely', !('agent' in b5));

  // ====================================================================
  // CASE 14 — mobile (360px): compact picker, menu fits viewport
  // ====================================================================
  console.log('\nCASE 14 — mobile');
  await page.evaluate(() => {
    localStorage.removeItem('opencode.agent');
    localStorage.removeItem('opencode.sessionAgents');
  });
  await page.setViewportSize({ width: 360, height: 740 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(1500);

  // close sidebar drawer (squeezes pane at mobile width)
  // close info panel first (its overlay blocks the burger at mobile width)
  const infoBtn = page.locator('button.burger[title="Toggle info panel"]');
  if (await infoBtn.isVisible().catch(() => false)) await infoBtn.click({ force: true });
  await sleep(300);
  const burger = page.locator('button.burger[title="Toggle sidebar"]');
  if (await burger.isVisible().catch(() => false)) await burger.click({ force: true });
  await sleep(500);
  // if sidebar is still open (squeeze check), close it again
  if (await burger.isVisible().catch(() => false)) await burger.click({ force: true });
  await sleep(300);

  const mpane = page.locator(`${PANE}`);
  const mbtn = mpane.locator('.toolbar .wrap:first-child .cur');
  const mtb = mpane.locator('#composer-input');
  const b1m = await mbtn.boundingBox();
  const t1m = await mtb.boundingBox();
  check(
    '14.1', 'picker fits within viewport at 360px',
    !!b1m && b1m.x >= 0 && b1m.x + b1m.width <= 361,
    `btn right=${b1m ? Math.round(b1m.x + b1m.width) : '?'}, viewport=360`,
  );
  check(
    '14.2', 'collapsed control compact at 360px',
    !!b1m && b1m.width <= 90,
    `width=${b1m ? Math.round(b1m.width) : '?'}px`,
  );
  await mbtn.click();
  await mpane.locator('.wrap .menu').waitFor({ state: 'visible', timeout: 5000 });
  const mobMenu = await mpane.locator('.wrap .menu').boundingBox();
  check(
    '14.3', 'mobile menu stays in viewport',
    mobMenu && mobMenu.x >= 0 && mobMenu.x + mobMenu.width <= 361,
    `width=${mobMenu ? Math.round(mobMenu.width) : '?'}px`,
  );

  // ====================================================================
  // cleanup
  // ====================================================================
  console.log('\nCLEANUP');
  for (const sid of sessionIds) {
    await fetch(`${BASE.replace(PORT, '4096')}/session/${sid}`, { method: 'DELETE' }).catch(() => {});
  }
  } finally {
    await browser.close();
  }
} finally {
  await new Promise((r) => server.close(r));
}

// =============================== summary ====================================

console.log('\n================ SUMMARY ================');
let fails = 0;
for (const r of results) {
  const tag = r.pass ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${r.c} · ${r.name}${r.note ? ` — ${r.note}` : ''}`);
  if (!r.pass) fails++;
}
if (pageErrors.length) {
  console.log(`\npage errors observed (${pageErrors.length}):`);
  for (const e of [...new Set(pageErrors)].slice(0, 5)) console.log('  •', e.slice(0, 220));
}
console.log(`\nChecks: ${results.length} | failed: ${fails}`);
process.exitCode = fails ? 1 : 0;
