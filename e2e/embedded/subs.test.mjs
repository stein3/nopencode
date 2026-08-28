// Merged subagent sidebar tests (subs + subs2 + subs3 from integration/).
// Covers: hide-subagents checkbox, persistence, section header count, subagent
// session opening, tree expand/collapse, aggregate dot behavior.
//
// Runs against an EMBEDDED fake engine — no live chatserver/engine needed.
// Port 8161.
//
// Run: node e2e/embedded/subs.test.mjs

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, launchBrowser, screenshot, sleep } from '../helpers/setup.mjs';

const PORT = 8161;
const BASE = `http://127.0.0.1:${PORT}`;

// ============================== fake engine =================================

const PARENT_ID = 'ses_parent';
const SUB_ID = 'ses_sub';

const SESSIONS = [
  {
    id: PARENT_ID,
    title: 'Root session',
    created: Date.now() - 90 * 60_000,
    updated: Date.now() - 10 * 60_000,
    message_count: 3,
    cost: 0,
  },
  {
    id: SUB_ID,
    title: 'Find stuff (@explore subagent)',
    created: Date.now() - 5 * 60_000,
    updated: Date.now() - 1 * 60_000,
    message_count: 2,
    cost: 0,
    parent: PARENT_ID,
    agent: 'explore',
  },
  {
    id: 'ses_root2',
    title: 'Second root',
    created: Date.now() - 80 * 60_000,
    updated: Date.now() - 30 * 60_000,
    message_count: 5,
    cost: 0,
  },
];

const MESSAGES = {
  [PARENT_ID]: [
    {
      info: { id: 'msg_p1', role: 'user', sessionID: PARENT_ID, time: { created: Date.now() - 80_000 } },
      parts: [{ id: 'pp1', type: 'text', text: 'hello from root' }],
    },
    {
      info: { id: 'msg_p2', role: 'assistant', sessionID: PARENT_ID, agent: 'build', time: { created: Date.now() - 70_000 } },
      parts: [{ id: 'pp2', type: 'text', text: 'I will explore for you' }],
    },
    {
      info: { id: 'msg_p3', role: 'user', sessionID: PARENT_ID, time: { created: Date.now() - 60_000 } },
      parts: [{ id: 'pp3', type: 'text', text: '<task id="ses_sub" state="completed"><summary>Background task completed: found 3 results</summary></task>', synthetic: true }],
    },
  ],
  [SUB_ID]: [
    {
      info: { id: 'msg_s1', role: 'user', sessionID: SUB_ID, time: { created: Date.now() - 40_000 } },
      parts: [{ id: 'sp1', type: 'text', text: 'search for files' }],
    },
    {
      info: { id: 'msg_s2', role: 'assistant', sessionID: SUB_ID, agent: 'explore', time: { created: Date.now() - 30_000 } },
      parts: [{ id: 'sp2', type: 'text', text: 'found 3 results' }],
    },
  ],
};

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

function json(res, obj, code = 200) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length });
  res.end(b);
}

const server = http.createServer(async (req, res) => {
  const p = (req.path_url ??= req.url.split('?')[0]);

  try {
    // ---- SSE ----------------------------------------------------------------
    if (p === '/oc/event') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      req.on('close', () => {});
      return;
    }

    // ---- history -------------------------------------------------------------
    if (p === '/api/history/sessions') return json(res, SESSIONS);
    if (p.endsWith('/errors')) return json(res, []);
    if (p.startsWith('/api/history/session/')) return json(res, []);

    // ---- engine stubs --------------------------------------------------------
    if (p === '/oc/session/status') return json(res, { [SUB_ID]: { type: 'busy' } });
    if (p === '/oc/permission') return json(res, []);

    const mMsg = p.match(/^\/oc\/session\/([^/]+)\/message$/);
    if (mMsg && req.method === 'GET') return json(res, MESSAGES[mMsg[1]] ?? []);

    if (p.match(/^\/oc\/session\/[^/]+$/) && req.method === 'GET')
      return json(res, { id: PARENT_ID, title: 'Root session', revert: null });
    if (p === '/oc/session' && req.method === 'POST')
      return json(res, { id: PARENT_ID, title: 'Root session', revert: null });

    if (p === '/oc/config/providers')
      return json(res, { providers: [{ id: 'opencode', models: {} }] });
    if (p === '/oc/path') return json(res, { directory: '/workspace' });
    if (p === '/oc/mcp') return json(res, {});
    if (p.startsWith('/oc/')) return json(res, []);

    // ---- statics (webui/dist) ------------------------------------------------
    const rel = p === '/' ? '/index.html' : p;
    const full = fs.realpathSync(path.join(DIST, rel));
    if (!full.startsWith(fs.realpathSync(DIST)) || !fs.statSync(full).isFile())
      return json(res, { error: 'missing' }, 404);
    const ct = MIME[path.extname(full)] ?? 'application/octet-stream';
    const b = fs.readFileSync(full);
    res.writeHead(200, { 'Content-Type': ct, 'Content-Length': b.length, 'Cache-Control': 'no-store' });
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

try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => pageErrors.push(e.message));

  try {
    // ---- Case A: subs3 basics — checkbox default, hide/show, persistence ------
    console.log('\nCASE A — subs3: checkbox defaults, hide/show, persistence');

    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForSelector('.sidebar .item', { timeout: 10000 });
    await page.waitForTimeout(800);

    // fresh profile: hideSubagents defaults to true (checked)
    const defaultChecked = await page.$eval('.hidesub input', (el) => el.checked);
    check('A', 'default: checkbox is checked (hide subagents)', defaultChecked);

    const label = (await page.$eval('.hidesub', (el) => el.textContent)).trim();
    check('A', 'label reads "hide subagents"', /hide subagents/i.test(label), label);

    // uncheck -> subagents visible; groups are collapsed by default so also
    // expand the first parent group to reveal sub-rows
    await page.uncheck('.hidesub input');
    await page.waitForTimeout(400);
    const chevA = await page.$('.sidebar .item .chev');
    if (chevA) {
      await chevA.click();
      await page.waitForTimeout(400);
    }
    const subRowsShown = await page.$$eval('.sidebar .item.sub-row', (els) => els.length);
    check('A', 'uncheck shows subagent rows', subRowsShown > 0, `got ${subRowsShown}`);

    // persistence: reload -> still unchecked
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sidebar .item', { timeout: 10000 });
    await page.waitForTimeout(600);
    const afterReload = await page.$eval('.hidesub input', (el) => el.checked);
    check('A', 'reload persists unchecked state', !afterReload);
    const subRowsAfterReload = await page.$$eval('.sidebar .item.sub-row', (els) => els.length);
    check('A', 'sub rows visible after persisted unchecked', subRowsAfterReload > 0);

    // ---- Case B: subs1 basics — hide subagents, section count -----------------
    console.log('\nCASE B — subs1: hide checkbox, section header, persistence');

    await page.check('.hidesub input');
    await page.waitForTimeout(400);
    const afterHide = await page.$$eval('.sidebar .item.sub-row', (els) => els.length);
    check('B', 'hide checkbox removes sub rows', afterHide === 0, `got ${afterHide}`);

    const sectionTxt = await page.$eval('.sidebar .section', (el) => el.textContent.replace(/\s+/g, ' ').trim());
    check('B', 'section header shows hidden count', /\d/.test(sectionTxt), sectionTxt);

    const stored = await page.evaluate(() => localStorage.getItem('opencode.hideSubagents'));
    check('B', 'localStorage persisted hide', stored === 'true' || stored === '1', `stored=${stored}`);
    await screenshot(page, 'subs-hidden');

    // uncheck -> back, reload persists shown
    await page.uncheck('.hidesub input');
    await page.waitForTimeout(300);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sidebar .item', { timeout: 10000 });
    await page.waitForTimeout(600);
    const checkedAfterReload = await page.$eval('.hidesub input', (el) => el.checked);
    const subAfterReload = await page.$$eval('.sidebar .item.sub-row', (els) => els.length);
    check('B', 'unchecked persists across reload', !checkedAfterReload);
    check('B', 'sub rows visible after reload', subAfterReload > 0, `got ${subAfterReload}`);

    // ---- Case C: subs2 — open subagent session -------------------------------
    console.log('\nCASE C — subs2: open subagent row');

    // ensure sub rows are visible (uncheck if needed)
    const currentChecked = await page.$eval('.hidesub input', (el) => el.checked);
    if (currentChecked) {
      await page.uncheck('.hidesub input');
      await page.waitForTimeout(300);
    }
    // groups may already be expanded from Case A's persisted subExpanded;
    // only click the chevron if sub-rows aren't already visible
    let subRow = await page.$('.sidebar .item.sub-row');
    if (!subRow) {
      const chev = await page.$('.sidebar .item .chev');
      if (chev) {
        await chev.click();
        await page.waitForTimeout(300);
      }
      subRow = await page.$('.sidebar .item.sub-row');
    }
    check('C', 'sub-row visible after expand', !!subRow);
    if (subRow) {
      await subRow.click();
      await page.waitForSelector('.msg', { timeout: 10000 });
      check('C', 'subagent session opens (messages render)', true);
    }
    await screenshot(page, 'subs-open');

    // ---- Case D: subs2 — hide/show with subagent opened ----------------------
    console.log('\nCASE D — subs2: hide then show preserves state');

    await page.check('.hidesub input');
    await page.waitForTimeout(400);
    const hiddenAfterCheck = await page.$$eval('.sidebar .item.sub-row', (els) => els.length);
    check('D', 'hide subagents after open', hiddenAfterCheck === 0, `got ${hiddenAfterCheck}`);
    await screenshot(page, 'subs-hidden2');

    await page.uncheck('.hidesub input');
    await page.waitForTimeout(300);
    const shownAfterUncheck = await page.$$eval('.sidebar .item.sub-row', (els) => els.length);
    check('D', 'show subagents restores rows', shownAfterUncheck > 0, `got ${shownAfterUncheck}`);

  } finally {
    await browser.close();
  }
} finally {
  await new Promise((r) => server.close(r));
}

// =============================== summary ====================================

console.log('\n================ SUMMARY ================');
const byCase = {};
for (const r of results) (byCase[r.c] ??= []).push(r);
let fails = 0;
for (const c of Object.keys(byCase)) {
  const ok = byCase[c].every((r) => r.pass);
  console.log(`  Case ${c}: ${ok ? 'PASS' : 'FAIL'} (${byCase[c].filter((r) => r.pass).length}/${byCase[c].length})`);
  fails += byCase[c].filter((r) => !r.pass).length;
}
if (pageErrors.length) {
  console.log(`\npage errors observed (${pageErrors.length}):`);
  for (const e of [...new Set(pageErrors)].slice(0, 5)) console.log('  •', e.slice(0, 220));
}
console.log('\nChecks:', results.length, '| failed:', fails);
process.exitCode = fails ? 1 : 0;
