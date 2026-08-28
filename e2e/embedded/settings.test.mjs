// verify-settings.mjs — headless validation for the Settings page + sidebar
// gear button. Runs against an EMBEDDED fake engine (same pattern as
// question-picker.test.mjs), so no live engine/chatserver is needed.
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
//   MB mobile overflow check @420px
//
// Run: node e2e/embedded/settings.test.mjs

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, SHOTS_DIR, launchBrowser, screenshot, sleep } from '../helpers/setup.mjs';

const PORT = 8160;
const BASE = `http://127.0.0.1:${PORT}`;
const SID = 'ses_settings';

// ============================== fake engine =================================

const state = {
  counts: {},
};
const sseClients = new Set();

function sseEmit(type, properties = {}) {
  const frame = `data: ${JSON.stringify({ type, properties })}\n\n`;
  for (const res of sseClients) {
    try { res.write(frame); } catch { /* dropped */ }
  }
}

const MESSAGES = [
  {
    info: {
      id: 'msg_settings1',
      role: 'assistant',
      agent: 'build',
      modelID: 'x-preview-f-free',
      providerID: 'opencode',
      time: { created: Date.now() - 60_000 },
    },
    parts: [
      {
        id: 'part_s1',
        type: 'text',
        text: 'Ready.',
      },
    ],
  },
];

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
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length });
  res.end(b);
}

const server = http.createServer(async (req, res) => {
  const p = (req.path_url ??= req.url.split('?')[0]);
  state.counts[p] = (state.counts[p] ?? 0) + 1;

  try {
    // ---- test introspection + control --------------------------------------
    if (p === '/__state') {
      return json(res, { counts: state.counts });
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

    // ---- history (chatserver stubs) ------------------------------------------
    if (p === '/api/history/sessions') {
      return json(res, [
        {
          id: SID,
          title: 'settings-probe',
          created: Date.now() - 120_000,
          updated: Date.now() - 30_000,
          message_count: 1,
          cost: 0,
        },
      ]);
    }
    if (p.endsWith('/errors')) {
      if (req.method === 'GET') return json(res, []);
      return json(res, { ok: true });
    }
    if (p.startsWith('/api/history/session/')) return json(res, []);

    // ---- engine stubs --------------------------------------------------------
    if (p === '/oc/session/status') return json(res, {});
    if (p.startsWith('/oc/session/') && p.endsWith('/message')) return json(res, MESSAGES);
    if (p.startsWith('/oc/session/')) return json(res, { id: SID, title: 'settings-probe', revert: null });
    if (p === '/oc/session' && req.method === 'POST')
      return json(res, { id: SID, title: 'settings-probe', revert: null });
    if (p === '/oc/config/providers')
      return json(res, {
        providers: [{ id: 'opencode', models: { 'x-preview-f-free': { id: 'x-preview-f-free' } } }],
      });
    if (p === '/oc/path') return json(res, { directory: '/workspace' });
    if (p === '/oc/mcp') return json(res, {});
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

try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const browser = await launchBrowser();

  try {
    // ============================ desktop =====================================
    console.log('\n--- Desktop viewport (1280×900) ---');
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
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
    console.log('\nCASE G1 — gear placement');
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
    check('G1', 'gear exists in .top', !!gearInfo);
    check('G1', 'gear is FIRST child (left of New chat)', gearInfo?.kids?.[0] === 'gear', JSON.stringify(gearInfo?.kids));
    check('G1', 'gear left of New chat, both visible', !!gearInfo?.gearLeftOfNew && !!gearInfo?.bothVisible);
    check('G1', 'tooltip says Settings', gearInfo?.gearTitle === 'Settings');

    await screenshot(page, 'settings-sidebar-gear');

    // S2 — open
    console.log('\nCASE S2 — settings page opens');
    await page.click('.sidebar .gear');
    await page.waitForSelector('.settings', { timeout: 5000 });
    check('S2', 'settings page opens', true);
    check(
      'S2',
      'role=dialog labelled Settings',
      (await page.getAttribute('.settings', 'role')) === 'dialog',
    );
    check('S2', 'header title', (await page.textContent('.settings .htitle'))?.trim() === 'Settings');

    // T3 — toggles render with sane defaults
    console.log('\nCASE T3 — toggle defaults');
    const names = await page.$$eval('.settings .row .name', (els) => els.map((e) => e.textContent.trim()));
    check(
      'T3',
      'four display prefs listed',
      ['Hide subagents', 'Show message timestamps', 'Always expand thinking blocks', 'Info panel open'].every((n) =>
        names.includes(n),
      ),
      JSON.stringify(names),
    );
    const rowBy = (t) => page.locator('.settings .row', { hasText: t });
    check('T3', 'hide-subagents defaults ON', await rowBy('Hide subagents').locator('input').isChecked());

    // T4 — flips persist through the stores to localStorage
    console.log('\nCASE T4 — toggle persistence');
    await rowBy('Hide subagents').click();
    await sleep(120);
    check(
      'T4',
      'hideSubagents OFF → ls "0"',
      (await page.evaluate(() => localStorage.getItem('opencode.hideSubagents'))) === '0',
    );
    await rowBy('Hide subagents').click();
    await sleep(120);
    check(
      'T4',
      'hideSubagents ON → ls "1"',
      (await page.evaluate(() => localStorage.getItem('opencode.hideSubagents'))) === '1',
    );
    await rowBy('Show message timestamps').click();
    await sleep(120);
    check(
      'T4',
      'showTimestamps OFF → ls "0"',
      (await page.evaluate(() => localStorage.getItem('opencode.showTimestamps'))) === '0',
    );
    const infoBefore = await page.evaluate(() => localStorage.getItem('opencode.infoOpen'));
    await rowBy('Info panel open').click();
    await sleep(120);
    const infoAfter = await page.evaluate(() => localStorage.getItem('opencode.infoOpen'));
    check('T4', 'infoOpen flip persists via toggleInfo', infoBefore !== infoAfter, `${infoBefore}→${infoAfter}`);
    await rowBy('Info panel open').click(); // restore
    await sleep(100);

    // R5 — read-only picks
    console.log('\nCASE R5 — model/agent display');
    const modelTxt = (await page.textContent('.settings .grid')).replace(/\s+/g, ' ');
    check('R5', 'model line is present', modelTxt.includes('model') && !modelTxt.includes('—'), modelTxt);
    check('R5', 'agent line present (Auto default)', modelTxt.includes('Auto (session default)'), modelTxt);

    // M6 — recents
    console.log('\nCASE M6 — model recents');
    check(
      'M6',
      'recents count shows 2 saved',
      ((await page.textContent('.settings .rechead .count')) || '').includes('2 saved'),
    );
    check('M6', 'recents lists 2 entries', (await page.$$('.settings .reclist li')).length === 2);
    await page.click('.settings .rechead .ghostbtn');
    await sleep(150);
    check('M6', 'clear empties list UI', !!(await page.$('.settings .empty')));
    check(
      'M6',
      'clear removes ls key',
      (await page.evaluate(() => localStorage.getItem('opencode.modelRecents'))) === null,
    );

    await screenshot(page, 'settings-open');

    // E7 — Escape closes
    console.log('\nCASE E7 — Escape closes');
    await page.keyboard.press('Escape');
    await sleep(150);
    check('E7', 'Escape closes settings', !(await page.$('.settings')));

    // P8 — persistence across reload
    console.log('\nCASE P8 — persistence across reload');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sidebar .gear', { timeout: 15000 });
    await page.click('.sidebar .gear');
    await page.waitForSelector('.settings', { timeout: 5000 });
    check('P8', 'timestamps stayed OFF after reload', !(await rowBy('Show message timestamps').locator('input').isChecked()));
    check('P8', 'hide-subagents stayed ON after reload', await rowBy('Hide subagents').locator('input').isChecked());
    await page.click('.settings .close'); // close-button affordance works too
    await sleep(120);
    check('P8', '✕ button closes settings', !(await page.$('.settings')));

    // D9 — danger zone
    console.log('\nCASE D9 — danger zone');
    await page.click('.sidebar .gear');
    await page.waitForSelector('.settings', { timeout: 5000 });
    await page.click('.settings .wipe');
    await sleep(120);
    check('D9', 'confirm step appears', !!(await page.$('.settings .confirm')));
    check('D9', 'confirm copy warns', ((await page.textContent('.settings .confirm')) || '').includes('Erase everything?'));
    await screenshot(page, 'settings-confirm');
    // Keep cancels
    await page.locator('.settings .confirm .ghostbtn').click();
    await sleep(120);
    check('D9', 'Keep cancels wipe', !(await page.$('.settings .confirm')));
    check(
      'D9',
      'nothing erased after cancel',
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
    check('D9', 'wipe clears pref values', post.timestamps === null && post.agents === null && post.recents === null, JSON.stringify(post));
    check('D9', 'settings closed after wipe-reload', !(await page.$('.settings')));
    check(
      'D9',
      'prefs back to defaults (hide ON)',
      await page.$eval('.hidesub input', (el) => el.checked),
    );

    await ctx.close();

    // ============================ mobile ======================================
    console.log('\n--- Mobile viewport (420×840) ---');
    const mctx = await browser.newContext({ viewport: { width: 420, height: 840 } });
    const mpage = await mctx.newPage();
    mpage.on('pageerror', (e) => pageErrors.push(e.message));
    await mpage.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await mpage.waitForSelector('.sidebar .gear', { timeout: 15000 });
    await mpage.click('.sidebar .gear');
    await mpage.waitForSelector('.settings', { timeout: 5000 });
    await sleep(300);
    const overflow = await mpage.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    check('MB', 'no horizontal overflow @420px', overflow <= 1, `overflow=${overflow}px`);
    await screenshot(mpage, 'settings-mobile');
    await mctx.close();
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
  console.log(`  [${tag}] ${r.name}${r.note ? ` — ${r.note}` : ''}`);
  if (!r.pass) fails++;
}
if (pageErrors.length) {
  console.log(`\npage errors observed (${pageErrors.length}):`);
  for (const e of [...new Set(pageErrors)].slice(0, 5)) console.log('  •', e.slice(0, 220));
}
console.log('\nChecks:', results.length, '| failed:', fails);
process.exitCode = fails ? 1 : 0;
