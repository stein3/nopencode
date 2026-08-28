// verify-linked.mjs — GitHub issue stein3/nopencode#4: "Linked Sessions"
// section in InfoPanel (right sidebar). Lists DIRECT child sessions of the
// active session with a solid status dot (perm > ask > busy > unread),
// @agent label, suffix-stripped title (ellipsis) and relTime; click opens
// the session via App's openHistory. Section hidden when no children or on
// pending-* tabs. Independent of $hideSubagents.
//
// Self-contained fake engine (same pattern as verify-hidelight.mjs):
// serves webui/dist + stub /oc + fixture endpoints + SSE, driven via
// /__ctl (status flips, SSE emit) and introspected via /__state.
//
// Checks:
//   L1 active root with 3 subs → 3 rows; dot classes perm/busy/busy;
//      @agent labels; suffix-stripped titles; relTime present
//   L2 click a sub row → its tab activates and transcript renders (.msg)
//   L3 childless active session → section absent entirely
//   L4 pending-* tab active → section absent
//   L5 busy→idle flip on a non-open sub surfaces as the UNREAD dot through
//      the real Sidebar poll-diff path (visibilitychange-triggered), then an
//      InfoPanel refetch (sid switch away+back) re-renders precedence
//
// Run: node e2e/embedded/linked-sessions.test.mjs
// Shots: .webtest/shots/linked-{panel,opened,unread}.png

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, launchBrowser, sleep, poll, screenshot, SHOTS_DIR } from '../helpers/setup.mjs';

const PORT = 8133;
const BASE = `http://127.0.0.1:${PORT}`;

// ============================== fixtures ====================================

const NOW = Date.now();
const M = 60000;
const SESSIONS = [
  {
    id: 'ses_main',
    title: 'Orchestrate the release',
    created: NOW - 90 * M,
    updated: NOW - 1 * M,
    message_count: 12,
    cost: 0,
    model: 'x-preview-f-free',
  },
  {
    id: 'ses_c1',
    title: 'Hunt regressions (@explore subagent)',
    created: NOW - 9 * M,
    updated: NOW - 5 * M,
    message_count: 3,
    cost: 0,
    model: 'ox-alpha-free',
    parent: 'ses_main',
    agent: 'explore',
  },
  {
    id: 'ses_c2',
    title: 'Refactor auth flow (@general subagent)',
    created: NOW - 8 * M,
    updated: NOW - 4 * M,
    message_count: 2,
    cost: 0,
    model: 'ox-alpha-free',
    parent: 'ses_main',
    agent: 'general',
  },
  {
    id: 'ses_c3',
    title: 'Sweep docs (@explore subagent)',
    created: NOW - 7 * M,
    updated: NOW - 3 * M,
    message_count: 2,
    cost: 0,
    model: 'ox-alpha-free',
    parent: 'ses_main',
    agent: 'explore',
  },
  {
    id: 'ses_solo',
    title: 'Solo session',
    created: NOW - 80 * M,
    updated: NOW - 40 * M,
    message_count: 1,
    cost: 0,
    model: 'x-preview-f-free',
  },
];
let STATUS = { ses_c2: { type: 'busy' }, ses_c3: { type: 'busy' } }; // c3 flips idle in L5
const PERMISSIONS = [
  { id: 'perm_linked1', sessionID: 'ses_c1', permission: 'bash', patterns: [], metadata: {} },
];
const MESSAGES = (sid) => [
  {
    info: {
      id: `msg_${sid}`,
      role: 'assistant',
      agent: 'build',
      modelID: 'x-preview-f-free',
      providerID: 'opencode',
      time: { created: NOW - 60_000 },
    },
    parts: [{ id: `part_${sid}`, type: 'text', text: `transcript of ${sid}` }],
  },
];

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
    if (p === '/__state') return json(res, { status: STATUS, counts: state.counts });
    if (p === '/__ctl') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (body.status) STATUS = body.status;
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

    // ---- engine stubs -------------------------------------------------------
    if (p === '/oc/session/status') return json(res, STATUS);
    if (p === '/oc/permission') return json(res, PERMISSIONS);
    if (p === '/oc/question') return json(res, []);
    const mMsg = p.match(/^\/oc\/session\/([^/]+)\/message$/);
    if (mMsg) return json(res, MESSAGES(mMsg[1]));
    const mSes = p.match(/^\/oc\/session\/([^/]+)$/);
    if (mSes) {
      const s = SESSIONS.find((x) => x.id === mSes[1]);
      return json(res, { id: mSes[1], title: s?.title ?? 'session', revert: null });
    }
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
    const b = fs.readFileSync(full);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] ?? 'application/octet-stream',
      'Content-Length': b.length,
      'Cache-Control': 'no-store',
    });
    res.end(b);
  } catch (e) {
    try {
      json(res, { error: String(e) }, 500);
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

const rowLoc = (page, title) => page.locator(`.info .kid[title="${title}"]`);

// ================================ run =======================================

const browser = await launchBrowser();

try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('.sidebar .item', { timeout: 10000 });
  await page.waitForSelector('.info .sec', { timeout: 10000 }); // auto-opens ses_main + panel
  await sleep(700);

  // ---- L1: three linked rows with correct dots/labels/titles ---------------
  const secTexts = await page.$$eval('.info .sec', (els) => els.map((e) => e.textContent.trim()));
  check('L1', 'Linked Sessions section present', secTexts.includes('Linked Sessions'), secTexts.join('|'));
  check(
    'L1',
    'Context/Todo sections still present',
    secTexts.includes('Context') && secTexts.includes('Todo'),
  );
  await poll(() => page.$('.info .kid') !== null);

  const rows = await page.$$eval('.info .kid', (els) =>
    els.map((el) => {
      // normalize: drop the base class + Svelte's scoping hash (svelte-xxxx)
      const dc = [...(el.querySelector('.dot')?.classList ?? [])].filter(
        (c) => c !== 'dot' && !c.startsWith('svelte-'),
      );
      return {
        title: el.getAttribute('title'),
        dot: dc.join(' '),
        ag: el.querySelector('.ag')?.textContent.trim() ?? '',
        tt: el.querySelector('.ttext')?.textContent.trim() ?? '',
        rt: el.querySelector('.rt')?.textContent.trim() ?? '',
      };
    }),
  );
  check('L1', 'exactly 3 rows', rows.length === 3, JSON.stringify(rows.map((r) => r.title)));
  const byTitle = Object.fromEntries(rows.map((r) => [r.tt, r]));
  check('L1', 'perm dot on c1', byTitle['Hunt regressions']?.dot === 'perm', byTitle['Hunt regressions']?.dot);
  check('L1', '@explore label on c1', byTitle['Hunt regressions']?.ag === '@explore');
  check('L1', 'busy dot on c2', byTitle['Refactor auth flow']?.dot === 'busy', byTitle['Refactor auth flow']?.dot);
  check('L1', '@general label on c2', byTitle['Refactor auth flow']?.ag === '@general');
  check('L1', 'c3 starts busy', byTitle['Sweep docs']?.dot === 'busy', byTitle['Sweep docs']?.dot);
  check(
    'L1',
    'titles suffix-stripped',
    rows.every((r) => !/@\w+ subagent\)/.test(r.tt)),
    rows.map((r) => r.tt).join(' | '),
  );
  check(
    'L1',
    'relTime rendered on every row',
    rows.every((r) => /\d|^now/i.test(r.rt)),
    rows.map((r) => r.rt).join(','),
  );
  // ellipsis wrapper actually engaged (min-width:0 chain)
  const ttCss = await page.$eval('.info .ttext', (el) => ({
    minw: getComputedStyle(el).minWidth,
    to: getComputedStyle(el).textOverflow,
  }));
  check('L1', '.ttext ellipsis styling', ttCss.minw === '0px' && ttCss.to === 'ellipsis', JSON.stringify(ttCss));

  await page.locator('.info').screenshot({ path: path.join(SHOTS_DIR, 'linked-panel.png') });

  // ---- L2: click a sub row → session opens ---------------------------------
  await rowLoc(page, 'Hunt regressions (@explore subagent)').click();
  // NOTE: the parent pane also renders .msg, so wait for TAB ACTIVATION first,
  // then assert the newly-visible transcript
  const activated = await poll(async () => {
    const lbl = await page
      .$eval('.tabbar .tab.active .label', (el) => el.textContent.trim())
      .catch(() => '');
    return lbl.includes('Hunt regressions');
  }, 8000);
  check('L2', 'clicked sub becomes active tab', activated);
  await page.waitForSelector('.tabpane[style*="flex"] .msg', { timeout: 10000 });
  check('L2', 'transcript rendered', true);
  await screenshot(page, 'linked-opened');

  // ---- L3: childless active session → section absent -----------------------
  await page.click('.sidebar .item[title="Solo session"]');
  await sleep(600);
  const soloSecs = await page.$$eval('.info .sec', (els) => els.map((e) => e.textContent.trim()));
  check('L3', 'no Linked section on childless session', !soloSecs.includes('Linked Sessions'), soloSecs.join('|'));
  check('L3', 'zero kid rows', (await page.$$eval('.info .kid', (els) => els.length)) === 0);

  // ---- L4: pending-* tab → section absent ----------------------------------
  await page.click('.sidebar .new'); // creates + activates a pending-* tab
  await sleep(600);
  const pendSecs = await page.$$eval('.info .sec', (els) => els.map((e) => e.textContent.trim()));
  check('L4', 'no Linked section on pending tab', !pendSecs.includes('Linked Sessions'), pendSecs.join('|'));

  // ---- L5: busy→idle flip surfaces as unread dot ---------------------------
  // c3 goes idle while NOT open → Sidebar's real poll-diff marks it unread;
  // visibilitychange triggers that poll instantly (headless doc is "visible")
  await fetch(`${BASE}/__ctl`, {
    method: 'POST',
    body: JSON.stringify({ status: { ses_c2: { type: 'busy' } } }),
  }).then((r) => r.json());
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await sleep(400);
  // force an InfoPanel refetch: switch away to solo, back to main
  await page.click('.sidebar .item[title="Solo session"]');
  await sleep(300);
  await page.click('.sidebar .item[title="Orchestrate the release"]');
  const flipped = await poll(async () =>
    (await page.$$eval('.info .kid .dot', (els) => els.map((e) => e.className))).some((c) =>
      c.includes('unread'),
    ),
  );
  check('L5', 'c3 shows unread dot after idle flip', flipped);
  const dots = await page.$$eval('.info .kid', (els) =>
    els.map((el) => ({
      tt: el.querySelector('.ttext')?.textContent.trim(),
      dot: [...el.querySelector('.dot').classList]
        .filter((c) => c !== 'dot' && !c.startsWith('svelte-'))
        .join(' '),
    })),
  );
  const d3 = dots.find((d) => d.tt === 'Sweep docs');
  check('L5', 'c3 dot is exactly unread', d3?.dot === 'unread', d3?.dot);
  check(
    'L5',
    'precedence intact (c1 perm, c2 busy)',
    dots.find((d) => d.tt === 'Hunt regressions')?.dot === 'perm' &&
      dots.find((d) => d.tt === 'Refactor auth flow')?.dot === 'busy',
    JSON.stringify(dots),
  );
  await page.locator('.info').screenshot({ path: path.join(SHOTS_DIR, 'linked-unread.png') });

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
