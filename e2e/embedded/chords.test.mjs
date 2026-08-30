// verify-chords.mjs — headless regression for the TUI-parity command palette
// (builtins only, Suggested + category groups) and the ctrl+x leader chords
// with the which-key hint strip.
//
// Fully self-contained: serves webui/dist from an EPHEMERAL 127.0.0.1 port via
// a tiny static http server (same conventions as verify-stall-retry.mjs). No
// engine/chatserver needed — palette + chords are client-side; /oc fetches
// fail harmlessly (app catches) and /oc/event + /oc/session/status are
// route-aborted to silence SSE reconnect noise.
//
// Checks:
//   P  ctrl+p palette: empty query → 'Suggested' header + Session/System
//      category headers; 'New session' row with 'ctrl+x n' hint; screenshot
//   F  typing 'compact' collapses to flat rows with NO section headers
//   C1 ctrl+x arms → which-key strip visible ('copy last' present); shot
//   C2 ctrl+x n → new tab appears AND strip hides
//   C3 ctrl+x b toggles sidebar off/on (visibility flips twice)
//   C4 ctrl+x m opens model picker; Escape closes it
//   C5 ctrl+x Escape disarms → plain 'n' does NOT open a tab afterwards
//   C6 ctrl+x z (unmapped) disarms silently, no crash
//   C7 ctrl+x alone times out (~2s window): strip hides by ~2.5s
//   T  typing guard: ctrl+x inside composer textarea does NOT arm; browser
//      cut falls through and a later 'x' types into the input
//
// Run:  node e2e/embedded/chords.test.mjs

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, launchBrowser, screenshot, sleep, poll } from '../helpers/setup.mjs';

// ========================= tiny static dist server ==========================

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

const server = http.createServer((req, res) => {
  const p = (req.path_url ??= req.url.split('?')[0]);
  try {
    // harmless stubs so boot-time fetches don't spam errors (no engine here).
    // Array-typed endpoints MUST return [] — a truthy {} would throw inside
    // consumers like AgentPicker's (list ?? []).filter (their .catch only
    // covers rejections, not 200s with the wrong shape).
    if (p === '/api/history/sessions') return json(res, []);
    if (p === '/oc/agent' || p === '/oc/command' || p === '/oc/skill') return json(res, []);
    if (p.startsWith('/api/') || p.startsWith('/oc/')) return json(res, {});
    // statics
    const rel = p === '/' ? '/index.html' : p;
    const full = fs.realpathSync(path.join(DIST, rel));
    if (!full.startsWith(fs.realpathSync(DIST)) || !fs.statSync(full).isFile())
      return json(res, { error: 'missing' }, 404);
    const ct = MIME[path.extname(full)] ?? 'application/octet-stream';
    const b = fs.readFileSync(full);
    res.writeHead(200, { 'Content-Type': ct, 'Content-Length': b.length, 'Cache-Control': 'no-store' });
    res.end(b);
  } catch {
    try {
      json(res, { error: 'missing' }, 404);
    } catch {}
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

await new Promise((r) => server.listen(0, '127.0.0.1', r)); // ephemeral port
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;
console.log(`serving ${DIST} on ${BASE}`);

try {
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => pageErrors.push(e.message));

  // silence SSE noise: abort the event stream + busy poll (client catches)
  await page.route('**/oc/event', (route) => route.abort());
  await page.route('**/oc/session/status', (route) => route.abort());

  try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.locator('.app').waitFor({ timeout: 15000 });
    await sleep(400); // let boot fetches settle

    const tabCount = () => page.locator('.tabbar .label').count();
    const strip = page.locator('.whichkey');

    // ---- P. palette groups (empty query) -----------------------------------
    console.log('\nCASE P — ctrl+p palette: builtins only, Suggested + category groups');
    await page.keyboard.press('Control+p');
    check('P', 'palette opens on ctrl+p', await poll(() => page.locator('.overlay .panel input').isVisible()));
    const heads = page.locator('.sechead');
    // headers render uppercase via CSS text-transform — compare rendered text
    const headTexts = (await heads.allInnerTexts()).map((t) => t.trim().toLowerCase());
    check('P', "empty query shows 'Suggested' header", headTexts.includes('suggested'), JSON.stringify(headTexts));
    check(
      'P',
      'category headers include Session + System',
      headTexts.includes('session') && headTexts.includes('system'),
      JSON.stringify(headTexts),
    );
    const newRow = page.locator('.row', { hasText: 'New session' }).first();
    check('P', "'New session' row visible", await poll(() => newRow.isVisible()));
    check(
      'P',
      "'New session' hint contains 'ctrl+x n'",
      (await newRow.locator('.hint').innerText().catch(() => '')).includes('ctrl+x n'),
    );
    check('P', 'engine-only sources absent (builtins only)', !(await page.locator('.badge').count()));
    await screenshot(page, 'palette-groups');

    // ---- F. filtering collapses to flat list -------------------------------
    console.log("\nCASE F — non-empty query: flat filtered list, no section headers");
    await page.locator('.overlay .panel input').fill('compact');
    check('F', "'Compact session' row appears when filtering", await poll(() => page.locator('.row', { hasText: 'Compact session' }).first().isVisible()));
    check('F', 'section headers removed while filtering', (await heads.count()) === 0);
    check('F', 'flat rows shown without slash-name prefixes', !(await page.locator('.row .name').count()));
    await page.keyboard.press('Escape');
    check('F', 'Escape closes the palette', await poll(async () => !(await page.locator('.overlay .panel').isVisible())));

    // ---- C1. arm + which-key strip ------------------------------------------
    console.log('\nCASE C1 — ctrl+x arms the chord and shows the which-key strip');
    await page.keyboard.press('Control+x');
    check('C1', 'which-key strip visible while armed', await poll(() => strip.isVisible()));
    check('C1', "strip lists 'copy last'", (await strip.innerText().catch(() => '')).includes('copy last'));
    await screenshot(page, 'chords-whichkey');

    // ---- C2. chord n → new tab, strip hides ---------------------------------
    console.log('\nCASE C2 — ctrl+x then n opens a new session tab');
    const before = await tabCount();
    await page.keyboard.press('n');
    check('C2', 'new tab appeared', await poll(async () => (await tabCount()) === before + 1));
    check('C2', 'strip hidden after chord resolves', await poll(async () => !(await strip.isVisible())));
    check('C2', 'composer visible in the new active pane', await poll(() => page.locator('.tabpane[style*="flex"] #composer-input').isVisible()));

    // ---- C3. chord b toggles sidebar twice ----------------------------------
    console.log('\nCASE C3 — ctrl+x then b toggles the sidebar off/on');
    const sidebar = page.locator('aside.sidebar');
    check('C3', 'sidebar visible initially', await sidebar.isVisible());
    await page.keyboard.press('Control+x');
    check('C3', 'armed again (strip visible)', await poll(() => strip.isVisible()));
    await page.keyboard.press('b');
    check('C3', 'sidebar hidden after ctrl+x b', await poll(async () => !(await sidebar.isVisible())));
    await page.keyboard.press('Control+x');
    await page.keyboard.press('b');
    check('C3', 'sidebar visible again after second ctrl+x b', await poll(() => sidebar.isVisible()));

    // ---- C4. chord m opens model picker, Escape closes ----------------------
    console.log('\nCASE C4 — ctrl+x then m opens the model picker; Escape closes');
    await page.keyboard.press('Control+x');
    await page.keyboard.press('m');
    check('C4', 'model picker menu opened', await poll(() => page.locator('.toolbar .menu').isVisible()));
    await page.keyboard.press('Escape');
    check('C4', 'model picker closed by Escape', await poll(async () => !(await page.locator('.toolbar .menu').isVisible())));

    // ---- C5. Escape disarms; stray plain key does nothing --------------------
    console.log('\nCASE C5 — ctrl+x then Escape disarms; plain n is inert');
    await page.keyboard.press('Control+x');
    check('C5', 'strip visible before Escape', await poll(() => strip.isVisible()));
    await page.keyboard.press('Escape');
    check('C5', 'strip hidden after Escape disarm', await poll(async () => !(await strip.isVisible())));
    const tabsBeforeN = await tabCount();
    await page.keyboard.press('n');
    await sleep(350);
    check('C5', 'plain n after disarm did NOT open a tab', (await tabCount()) === tabsBeforeN);

    // ---- C6. unmapped plain key disarms silently -----------------------------
    console.log('\nCASE C6 — ctrl+x then z (unmapped) disarms silently');
    await page.keyboard.press('Control+x');
    check('C6', 'armed before unmapped key', await poll(() => strip.isVisible()));
    await page.keyboard.press('z');
    check('C6', 'strip hidden after unmapped key', await poll(async () => !(await strip.isVisible())));
    check('C6', 'still one pane, no crash', (await page.locator('.tabpane[style*="flex"]').count()) === 1);

    // ---- C7. arming times out on its own -------------------------------------
    console.log('\nCASE C7 — ctrl+x alone: strip auto-hides after the ~2s window');
    await page.keyboard.press('Control+x');
    check('C7', 'strip visible right after arming', await poll(() => strip.isVisible(), 800));
    const goneBy = await poll(async () => !(await strip.isVisible()), 2600, 100);
    check('C7', 'strip hidden within ~2.5s without any key', goneBy);

    // ---- T. typing guard: no arming inside inputs ----------------------------
    console.log('\nCASE T — ctrl+x while typing falls through (browser cut preserved)');
    const pane = page.locator('.tabpane[style*="flex"]');
    const input = pane.locator('#composer-input');
    await input.click();
    await page.keyboard.press('Control+x');
    await sleep(400);
    check('T', 'strip did NOT appear while focus is in the composer', !(await strip.isVisible()));
    await page.keyboard.press('x');
    check('T', "typing 'x' lands in the input (cut shortcut not hijacked)", (await input.inputValue()) === 'x');

    // ---- final ----------------------------------------------------------------
    check('Z', 'no uncaught page errors during the whole run', pageErrors.length === 0, pageErrors[0] ?? '');
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
