// draft-guard.test.mjs — unsent compose-box text is not silently thrown away.
//
// A tab's draft lives only in that pane's Composer component, and the open-tab
// persistence layer deliberately stores ids only (never box text), so closing a
// tab, reloading, or closing the window used to eat an unsent message. Now:
//   • closeTab() confirms when THAT tab's box holds text, and
//   • a beforeunload listener lets the browser prompt on reload/close.
//
// Self-contained: serves webui/dist on an ephemeral-ish fixed port with a fake
// backend that has NO sessions (boot opens none; every tab here is a local
// `pending-*` tab from the + button, so no prompt POSTs are needed).
//
// Checks:
//   D1 an empty box closes the tab with NO confirm dialog
//   D2 typing arms the confirm: dismissing it keeps the tab AND the text
//   D3 accepting it closes the tab
//   D4 clearing the box disarms the confirm again (tracking flips both ways)
//   D5 reload with a draft fires a beforeunload dialog (accepted → reload runs)
//   D6 reload with an empty box fires NO beforeunload dialog
//
// Run: node e2e/embedded/draft-guard.test.mjs

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, launchBrowser, sleep, poll } from '../helpers/setup.mjs';

const PORT = Number(process.env.PORT) || 8186;
const BASE = `http://127.0.0.1:${PORT}`;

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
  '.webmanifest': 'application/manifest+json',
};

// No sessions at all: /api/history/sessions → [] and /oc/session → [] means the
// app boots with an empty tab bar. /oc/workspaces must NOT look workspace-capable
// (shape check on {chips, root}), so ctrl+t / + make a local pending tab.
const server = http.createServer((req, res) => {
  const p = (req.path_url ??= req.url.split('?')[0]);
  const json = (obj, code = 200) => {
    const b = Buffer.from(JSON.stringify(obj));
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length });
    res.end(b);
  };
  try {
    if (p === '/api/history/sessions' || p === '/oc/session') return json([]);
    if (p === '/oc/permission' || p === '/oc/agent' || p === '/oc/command' || p === '/oc/skill')
      return json([]);
    if (p === '/oc/session/status') return json({});
    if (p.startsWith('/api/') || p.startsWith('/oc/')) return json({});
    const rel = p === '/' ? '/index.html' : p;
    const full = fs.realpathSync(path.join(DIST, rel));
    if (!full.startsWith(fs.realpathSync(DIST)) || !fs.statSync(full).isFile())
      return json({ error: 'missing' }, 404);
    const b = fs.readFileSync(full);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] ?? 'application/octet-stream',
      'Content-Length': b.length,
      'Cache-Control': 'no-store',
    });
    res.end(b);
  } catch {
    try {
      json({ error: 'missing' }, 404);
    } catch {}
  }
});

const results = [];
let pageErrors = [];
function check(c, name, pass, note = '') {
  results.push({ c, name, pass: !!pass, note });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${c} · ${name}${note ? ` — ${note}` : ''}`);
}

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
console.log(`serving ${DIST} on ${BASE}`);

try {
  const browser = await launchBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.route('**/oc/event', (route) => route.abort());

  // Playwright dismisses dialogs by default, which would look like "the user
  // cancelled" for every case — record each one and answer per verdict.
  const dialogs = [];
  let verdict = 'dismiss';
  page.on('dialog', async (d) => {
    dialogs.push({ type: d.type(), message: d.message() });
    try {
      if (verdict === 'accept') await d.accept();
      else await d.dismiss();
    } catch {}
  });

  const tabCount = () => page.locator('.tabbar [role="tab"]').count();
  const box = () => page.locator('.tabpane[style*="flex"] textarea#composer-input');
  const newTab = async () => {
    await page.locator('.tabbar .add').click();
    await box().waitFor({ timeout: 5000 });
  };
  const closeActiveTab = async (accept) => {
    verdict = accept ? 'accept' : 'dismiss';
    const before = dialogs.length;
    await page.locator('.tabbar [role="tab"]').last().locator('.x').click();
    await sleep(400);
    return dialogs.slice(before);
  };
  // real keystrokes, not fill(): Chromium only honours a beforeunload prompt
  // once the page has had a user interaction
  const typeDraft = async (t) => {
    await box().click();
    await page.keyboard.type(t);
    await poll(async () => (await box().inputValue()) === t, 3000);
  };

  try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.locator('.app').waitFor({ timeout: 15000 });
    await sleep(500);
    check('setup', 'boots with no tabs (no sessions on the fake backend)', (await tabCount()) === 0);

    // ---- D1: empty box → close is silent -----------------------------------
    console.log('\nCASE D1 — an empty compose box closes without asking');
    await newTab();
    let fired = await closeActiveTab(false);
    check('D1', 'no confirm dialog for an empty box', fired.length === 0, JSON.stringify(fired));
    check('D1', 'the tab closed', (await tabCount()) === 0);

    // ---- D2: draft armed → dismiss keeps everything ------------------------
    console.log('\nCASE D2 — a draft arms the confirm; dismissing keeps tab + text');
    await newTab();
    await typeDraft('do not lose this please');
    fired = await closeActiveTab(false);
    check('D2', 'a confirm dialog fired', fired.length === 1 && fired[0].type === 'confirm', JSON.stringify(fired));
    check('D2', 'it names the unsent message', /unsent message/i.test(fired[0]?.message ?? ''), fired[0]?.message ?? '');
    check('D2', 'dismissing kept the tab open', (await tabCount()) === 1);
    check('D2', 'the draft survived the attempt', (await box().inputValue()) === 'do not lose this please');

    // ---- D3: accept → tab goes ---------------------------------------------
    console.log('\nCASE D3 — accepting the confirm closes the tab');
    fired = await closeActiveTab(true);
    check('D3', 'confirm fired again', fired.length === 1 && fired[0].type === 'confirm', JSON.stringify(fired));
    check('D3', 'accepting closed the tab', (await poll(async () => (await tabCount()) === 0, 3000)) !== false);

    // ---- D4: clearing the box disarms --------------------------------------
    console.log('\nCASE D4 — emptying the box disarms the confirm again');
    await newTab();
    await typeDraft('scratch');
    await box().fill('');
    await sleep(200);
    fired = await closeActiveTab(false);
    check('D4', 'no confirm after the text was deleted', fired.length === 0, JSON.stringify(fired));
    check('D4', 'the tab closed', (await tabCount()) === 0);

    // ---- D5: reload with a draft → beforeunload ----------------------------
    console.log('\nCASE D5 — reload with a draft fires beforeunload');
    await newTab();
    await typeDraft('reload me and lose me');
    verdict = 'accept';
    const before = dialogs.length;
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.locator('.app').waitFor({ timeout: 15000 });
    const unload = dialogs.slice(before);
    check('D5', 'a beforeunload dialog fired', unload.length === 1 && unload[0].type === 'beforeunload', JSON.stringify(unload));
    check('D5', 'accepting it completed the reload', (await page.locator('.app').count()) === 1);
    check('D5', 'no tab was restored (pending tabs are not persisted)', (await tabCount()) === 0);

    // ---- D6: empty box → reload is silent ----------------------------------
    console.log('\nCASE D6 — reload with an empty box fires nothing');
    await newTab();
    const before2 = dialogs.length;
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.locator('.app').waitFor({ timeout: 15000 });
    const unload2 = dialogs.slice(before2);
    check('D6', 'no beforeunload dialog for an empty box', unload2.length === 0, JSON.stringify(unload2));

    check('Z', 'no uncaught page errors', pageErrors.length === 0, pageErrors[0] ?? '');
  } finally {
    await browser.close();
  }
} finally {
  await new Promise((r) => server.close(r));
}

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
