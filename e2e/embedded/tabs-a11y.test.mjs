// tabs-a11y.test.mjs — the tab strip ↔ tab pane relationship, and the copy
// button's keyboard path after the a11y cleanup (Transcript's delegated
// code-copy click moved from `on:click` on the scroller to the `use:codeCopy`
// action, and the panes became role="tabpanel" + inert when hidden).
//
// Self-contained: serves webui/dist from an ephemeral port with a minimal fake
// engine (two seeded sessions so two panes exist at once).
//
// Checks:
//   A1 every role="tab" carries aria-controls pointing at an existing pane id
//   A2 every role="tabpanel" is labelled by its tab (aria-labelledby resolves)
//   A3 the ACTIVE pane is not inert; the inactive one is (screen readers and
//      Tab must not walk into a display:none pane)
//   A4 switching tabs moves inert along with the visible pane
//   A5 the transcript scroller is role="log" with a per-session name
//   A6 code-copy still works via the keyboard (Tab to the button, Enter) —
//      proves the action-based delegation did not break the a11y path
//
// Run: node e2e/embedded/tabs-a11y.test.mjs

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, launchBrowser, sleep, poll } from '../helpers/setup.mjs';

const PORT = Number(process.env.PORT) || 8179;
const BASE = `http://127.0.0.1:${PORT}`;

const SID_A = 'ses_a11ytaba';
const SID_B = 'ses_a11ytabb';

const CODE = 'const a = 1\nconst b = 2\n'

const sessions = {
  [SID_A]: { id: SID_A, title: 'a11y tab A' },
  [SID_B]: { id: SID_B, title: 'a11y tab B' },
};

const messages = {
  [SID_A]: [
    {
      info: { id: 'msg_a11ya1', role: 'assistant', time: { created: Date.now() - 60_000 } },
      parts: [{ id: 'part_a11ya1', type: 'text', text: '```ts\n' + CODE + '```' }],
    },
  ],
  [SID_B]: [
    {
      info: { id: 'msg_a11yb1', role: 'user', time: { created: Date.now() - 50_000 } },
      parts: [{ id: 'part_a11yb1', type: 'text', text: 'second session' }],
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
  '.webmanifest': 'application/manifest+json',
};

const server = http.createServer((req, res) => {
  const p = (req.path_url ??= req.url.split('?')[0]);
  const json = (obj, code = 200) => {
    const b = Buffer.from(JSON.stringify(obj));
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length });
    res.end(b);
  };
  try {
    if (p === '/api/history/sessions') return json(Object.values(sessions));
    const msg = p.match(/^\/oc\/session\/([^/]+)\/message$/);
    if (msg && sessions[msg[1]]) return json(messages[msg[1]] ?? []);
    const one = p.match(/^\/oc\/session\/([^/]+)$/);
    if (one && sessions[one[1]]) return json(sessions[one[1]]);
    if (p === '/oc/session') return json(Object.values(sessions));
    // Array-typed endpoints MUST be [] — the catch-all {} below would throw
    // inside consumers (permissions.ts does list.filter, see e2e/README notes).
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
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.route('**/oc/event', (route) => route.abort());
  await page.route('**/oc/session/status', (route) => route.abort());

  try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.locator('.app').waitFor({ timeout: 15000 });
    await sleep(400);

    // open a second tab so two panes exist simultaneously
    await page.locator('.tabbar .add').click();
    await sleep(300);
    // rename-free: just make sure we have 2 tabs, then seed pane B by clicking tab 2
    check('setup', 'two tabs open', (await page.locator('.tabbar [role="tab"]').count()) === 2);

    // ---- A1/A2: id + relationship wiring ------------------------------------
    console.log('\nCASE A1/A2 — tabs and panes reference each other by id');
    const rel = await page.evaluate(() => {
      const tabs = [...document.querySelectorAll('.tabbar [role="tab"]')];
      return tabs.map((t) => {
        const cid = t.getAttribute('aria-controls');
        const pane = cid ? document.getElementById(cid) : null;
        const back = pane?.getAttribute('aria-labelledby');
        return {
          id: t.id || '',
          controls: cid || '',
          paneExists: !!pane,
          paneRole: pane?.getAttribute('role') || '',
          labelledByTab: !!pane && back === t.id,
        };
      });
    });
    check('A1', 'every tab has aria-controls to a real element', rel.length === 2 && rel.every((r) => r.controls && r.paneExists), JSON.stringify(rel));
    check('A2', 'every pane is role=tabpanel labelled by its own tab', rel.every((r) => r.paneRole === 'tabpanel' && r.labelledByTab), JSON.stringify(rel));

    // ---- A3/A4: inert follows visibility ------------------------------------
    console.log('\nCASE A3/A4 — inactive panes are inert, the active one is not');
    const inertState = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('.tabpane')].map((p) => ({
          id: p.id,
          shown: getComputedStyle(p).display !== 'none',
          inert: p.inert === true || p.getAttribute('inert') === '',
        }))
      );
    let st = await poll(async () => {
      const s = await inertState();
      return s.every((p) => p.shown !== p.inert) ? s : false;
    }, 4000);
    check('A3', 'exactly the visible pane is focusable (others inert)', !!st, JSON.stringify(st));

    await page.locator('.tabbar [role="tab"]').first().click();
    await sleep(250);
    st = await inertState();
    check('A4', 'inert moved with the active pane after switching', st.length === 2 && st.every((p) => p.shown !== p.inert), JSON.stringify(st));

    // ---- A5: the scroller is a named log ------------------------------------
    console.log('\nCASE A5 — transcript scroller is role=log with a session name');
    const logs = await page.evaluate(() =>
      [...document.querySelectorAll('.transcript')].map((el) => ({
        role: el.getAttribute('role') || '',
        name: el.getAttribute('aria-label') || '',
      }))
    );
    check('A5', 'every transcript is role=log with a non-empty aria-label', logs.length >= 1 && logs.every((l) => l.role === 'log' && l.name.length > 0), JSON.stringify(logs));

    // ---- A6: keyboard copy path through the action --------------------------
    console.log('\nCASE A6 — Enter on a focused code-copy button copies (action delegation)');
    await page.locator('.tabbar [role="tab"]').first().click();
    const btn = page.locator('.tabpane[style*="flex"] .codeblock button.code-copy').first();
    check('A6', 'copy button exists in the active pane', await poll(async () => (await btn.count()) > 0, 4000));
    await btn.focus();
    const focused = await page.evaluate(() => document.activeElement?.className || '');
    check('A6', 'the button itself took focus', String(focused).includes('code-copy'), focused);
    await page.keyboard.press('Enter');
    const clip = await poll(
      async () => {
        const t = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
        return t.includes('const a = 1') ? t : false;
      },
      3000
    );
    check('A6', 'Enter copied the fence body', !!clip, JSON.stringify(clip));

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
