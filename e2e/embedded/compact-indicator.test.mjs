// compact-indicator.test.mjs — the Footer's .status_indicator slot, driven by
// the engine's SSE events. Turn status ("thinking..." / "compacting...")
// lives in the footer; the Transcript only carries the compaction TELEMETRY box.
// Runs against an EMBEDDED fake engine (same pattern as qbanner.mjs).
//
// Cases:
//   A. session.next.compaction.started → .status_indicator.compacting in footer,
//      and NO .cmpbox.running in the transcript (no engine telemetry to show)
//   B. session.next.compaction.ended  → indicator clears
//   C. started again, then session.idle (missed ended) → indicator clears
//   D. session.status busy + reasoning-only assistant msg → .status_indicator.thinking;
//      no .live-thinking left in the composer toolbar
//   E. footer no longer prints the workspace/working-directory string
//   F. /session/status reports a failed summary → .cmpbox.failed (and a running
//      summary with NO engine telemetry shows footer dots only, never a failed box)
//   G. narrow viewport: the indicator's label truncates, footer never overflows,
//      and the centered label never runs under ctrl+p (340/390/480/620)
//   H. per-character blink floor stays > 0 (whole word readable mid-blink)
//   I. zone layout: context/cost anchored left, the animation centered//
// Run: node e2e/embedded/compact-indicator.test.mjs

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, launchBrowser, screenshot, sleep, SHOTS_DIR } from '../helpers/setup.mjs';

const PORT = 8176;
const BASE = `http://127.0.0.1:${PORT}`;
const SID = 'ses_compact';

// ============================== fake engine =================================

const state = { counts: {}, status: {} };
const sseClients = new Set();

function sseEmit(type, properties = {}) {
  const frame = `data: ${JSON.stringify({ type, properties })}\n\n`;
  for (const res of sseClients) {
    try { res.write(frame); } catch { /* dropped */ }
  }
}

const MESSAGES = [
  {
    info: { id: 'msg_c1', role: 'user', time: { created: Date.now() - 120_000 } },
    parts: [{ id: 'part_c1', type: 'text', text: 'seed user message' }],
  },
  {
    info: { id: 'msg_c2', role: 'assistant', agent: 'build', modelID: 'x-preview-f-free', providerID: 'opencode', tokens: { input: 8000, output: 900, reasoning: 100 }, time: { created: Date.now() - 110_000 } },
    parts: [{ id: 'part_c2', type: 'text', text: 'seed assistant reply' }],
  },
];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript',
  '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.map': 'application/json', '.txt': 'text/plain', '.wasm': 'application/wasm',
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
    if (p === '/__state') return json(res, { counts: state.counts });
    if (p === '/__ctl') {
      const ctl = JSON.parse((await readBody(req)) || '{}');
      if (ctl.emit) sseEmit(ctl.emit.type, ctl.emit.properties ?? {});
      if (ctl.status !== undefined) state.status = ctl.status;
      return json(res, { ok: true });
    }

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

    if (p === '/api/history/sessions') {
      return json(res, [{
        id: SID, title: 'Compaction indicator smoke', created: Date.now() - 300_000,
        updated: Date.now() - 10_000, message_count: MESSAGES.length, cost: 0,
      }]);
    }
    if (p.endsWith('/errors')) {
      if (req.method === 'GET') return json(res, []);
      return json(res, { ok: true });
    }
    if (p.startsWith('/api/history/session/')) return json(res, []);

    if (p === '/oc/session/status') return json(res, state.status);
    if (p.startsWith('/oc/session/') && p.endsWith('/message')) return json(res, MESSAGES);
    if (p.startsWith('/oc/session/')) return json(res, { id: SID, title: 'Compaction indicator smoke', cost: 0.42, revert: null });
    if (p === '/oc/session' && req.method === 'POST')
      return json(res, { id: SID, title: 'Compaction indicator smoke', revert: null });
    if (p === '/oc/config/providers')
      return json(res, {
        providers: [{ id: 'opencode', models: { 'x-preview-f-free': { id: 'x-preview-f-free' } } }],
      });
    if (p === '/oc/path') return json(res, { directory: '/workspace' });
    if (p === '/oc/mcp') return json(res, {});
    if (p.startsWith('/oc/')) return json(res, []);

    // the shared dist is built with base /webui/, but this fake serves the app at
    // '/' — strip the prefix so /webui/assets/* resolves (AGENTS: miss this and
    // every asset 404s and the app never mounts)
    const rel = p === '/' ? '/index.html' : p.startsWith('/webui/') ? p.slice(6) : p;
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

// ================================ helpers ====================================

const ctl = (payload) =>
  fetch(`${BASE}/__ctl`, { method: 'POST', body: JSON.stringify(payload) }).then((r) => r.json());

async function pollGone(page, sel, tries = 40) {
  for (let i = 0; i < tries; i++) {
    if ((await page.locator(sel).count()) === 0) return true;
    await sleep(300);
  }
  return false;
}

const results = [];
let pageErrors = [];

function check(c, name, pass, note = '') {
  results.push({ c, name, pass: !!pass, note });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${c} · ${name}${note ? ` — ${note}` : ''}`);
}

// ================================ run ========================================

try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const pane = page.locator('.tabpane[style*="flex"]');
  const footer = pane.locator('.footer');
  const indicator = footer.locator('.status_indicator.compacting');

  try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    // wait for the app to auto-open the seeded session
    await pane.locator('.msg').first().waitFor({ timeout: 15000 });
    check('A', 'no indicator before compaction starts', (await indicator.count()) === 0);

    // ---- E. the workspace string is gone from the footer ----------------------
    console.log('\nCASE E — footer carries no working-directory string');
    await footer.waitFor({ state: 'attached', timeout: 5000 });
    const footTxt = (await footer.textContent()) ?? '';
    check('E', 'no [title="working directory"] segment', (await footer.locator('[title="working directory"]').count()) === 0);
    check('E', 'footer text has no /workspace', !/\/workspace/.test(footTxt), `footer: ${footTxt.trim().slice(0, 120)}`);

    // ---- A. started → footer indicator appears, no telemetry box -------------
    console.log('\nCASE A — session.next.compaction.started shows footer indicator');
    await ctl({ emit: { type: 'session.next.compaction.started', properties: { sessionID: SID, messageID: 'msg_comp', reason: 'manual', timestamp: Date.now() } } });
    await indicator.waitFor({ timeout: 5000 });
    const txt = (await indicator.textContent()) ?? '';
    check('A', 'indicator shows "compacting"', /compacting/.test(txt), `text: ${txt.trim()}`);
    check('A', 'indicator is in the footer', await indicator.evaluate((el) => el.closest('.footer') !== null));
    const preBox = pane.locator('.cmpbox');
    const preN = await preBox.count();
    const preTxt = preN ? ((await preBox.first().textContent()) ?? '').trim() : '';
    check('A', 'no compaction box at all without engine metrics', preN === 0, `n=${preN} text: ${preTxt}`);
    check('A', 'no thinking indicator during compaction', (await footer.locator('.status_indicator.thinking').count()) === 0);
    await screenshot(page, 'compact-indicator');
    await footer.screenshot({ path: path.join(SHOTS_DIR, 'footer-compacting.png') });
    await sleep(450); // mid-blink: the label animates per character (0.1s stagger)
    await footer.screenshot({ path: path.join(SHOTS_DIR, 'footer-compacting-2.png') });

    // ---- I. zone layout: stats left-anchored, animation centered ------------
    console.log('\nCASE I — stats anchored left, status animation centered');
    const lay = await footer.evaluate((el) => {
      const fr = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const padL = parseFloat(cs.paddingLeft) || 0;
      const padR = parseFloat(cs.paddingRight) || 0;
      const q = (s) => el.querySelector(s)?.getBoundingClientRect();
      const cx = (r) => r.left + r.width / 2;
      const ind = q('.status_indicator');
      const ctr = q('.fcenter');
      const seg = q('.seg');
      const cmd = q('.cmd');
      return {
        centerDelta: ctr ? Math.round(Math.abs(cx(ctr) - cx(fr))) : null,
        indInCenter: !!el.querySelector('.fcenter .status_indicator'),
        segLeftGap: seg ? Math.round(seg.left - (fr.left + padL)) : null,
        cmdRightGap: cmd ? Math.round(fr.right - padR - cmd.right) : null,
      };
    });
    check('I', 'the status zone is centered in the footer', lay.centerDelta !== null && lay.centerDelta <= 2, JSON.stringify(lay));
    check('I', 'scanner + label travel as one centered group', lay.indInCenter === true, JSON.stringify(lay));
    check('I', 'context/cost anchored at the left edge', lay.segLeftGap !== null && lay.segLeftGap <= 1, JSON.stringify(lay));
    check('I', 'ctrl+p anchored at the right edge', lay.cmdRightGap !== null && lay.cmdRightGap <= 1, JSON.stringify(lay));

    // ---- A2. engine telemetry → transcript box (label stays in the footer) ---
    console.log('\nCASE A2 — session.status engine metrics show the transcript box');
    await ctl({ emit: { type: 'session.status', properties: { sessionID: SID, status: { type: 'engine', phase: 'prefill', prompt_read: 4000, prompt_total: 8000, tok_s: 210 } } } });
    const cmpbox = pane.locator('.cmpbox.running');
    await cmpbox.waitFor({ timeout: 5000 });
    const boxTxt = (await cmpbox.textContent()) ?? '';
    check('A2', 'transcript box shows the progress numbers', /4,000\/8,000/.test(boxTxt), `text: ${boxTxt.trim()}`);
    check('A2', 'transcript box does not repeat the label', !/compacting/.test(boxTxt), `text: ${boxTxt.trim()}`);
    check('A2', 'footer indicator still there', (await indicator.count()) > 0);

    // ---- H. the blink floor keeps the whole word readable -------------------
    console.log('\nCASE H — blink floor: no character blanks, every one peaks');
    const anim = await page.evaluate(async () => {
      const chars = [...document.querySelectorAll('.tabpane[style*="flex"] .footer .status_indicator .ch')];
      if (!chars.length) return null;
      let min = 1;
      const peaks = chars.map(() => 0);
      for (let s = 0; s < 20; s++) { // >1 full 1.4s cycle
        chars.forEach((el, i) => {
          const o = parseFloat(getComputedStyle(el).opacity);
          peaks[i] = Math.max(peaks[i], o);
          min = Math.min(min, o);
        });
        await new Promise((r) => setTimeout(r, 100));
      }
      return { n: chars.length, min, peakMin: Math.min(...peaks) };
    });
    check('H', 'no character ever blanks (floor > 0.25)', !!anim && anim.min > 0.25, JSON.stringify(anim));
    check('H', 'every character peaks near full opacity', !!anim && anim.peakMin > 0.9, JSON.stringify(anim));

    // ---- B. ended → indicator clears ---------------------------------------
    console.log('\nCASE B — session.next.compaction.ended clears indicator');
    await ctl({ emit: { type: 'session.next.compaction.ended', properties: { sessionID: SID, messageID: 'msg_comp', reason: 'manual', text: 'summary', recent: 'recent', timestamp: Date.now() } } });
    check('B', 'indicator disappears after ended', await pollGone(page, '.tabpane[style*="flex"] .footer .status_indicator.compacting'));
    check('B', 'telemetry box disappears too', (await pane.locator('.cmpbox.running').count()) === 0);

    // ---- C. started again, session.idle clears (missed ended) --------------
    console.log('\nCASE C — session.idle backstop clears a stuck indicator');
    await ctl({ emit: { type: 'session.next.compaction.started', properties: { sessionID: SID, messageID: 'msg_comp2', reason: 'auto', timestamp: Date.now() } } });
    await indicator.waitFor({ timeout: 5000 });
    await ctl({ emit: { type: 'session.idle', properties: { sessionID: SID } } });
    check('C', 'indicator disappears after session.idle', await pollGone(page, '.tabpane[style*="flex"] .footer .status_indicator.compacting'));

    // ---- D. busy + no reply text yet → "Thinking…" in the footer ------------
    console.log('\nCASE D — session.status busy shows the thinking indicator in the footer');
    const thinking = footer.locator('.status_indicator.thinking');
    check('D', 'no thinking indicator while idle', (await thinking.count()) === 0);
    await ctl({ emit: { type: 'session.status', properties: { sessionID: SID, status: { type: 'busy' } } } });
    await ctl({ emit: { type: 'message.updated', properties: { info: { id: 'msg_th', sessionID: SID, role: 'assistant', time: { created: Date.now() } } } } });
    await ctl({ emit: { type: 'message.part.updated', properties: { part: { id: 'part_th', messageID: 'msg_th', sessionID: SID, type: 'reasoning', text: 'pondering' } } } });
    await thinking.waitFor({ timeout: 5000 });
    const thTxt = (await thinking.textContent()) ?? '';
    check('D', 'thinking indicator shows "thinking"', /thinking/.test(thTxt), `text: ${thTxt.trim()}`);
    check('D', 'thinking indicator is in the footer', await thinking.evaluate((el) => el.closest('.footer') !== null));
    check('D', 'composer toolbar no longer carries .live-thinking', (await pane.locator('.live-thinking').count()) === 0);
    await screenshot(page, 'compact-indicator-thinking');
    await footer.screenshot({ path: path.join(SHOTS_DIR, 'footer-thinking.png') });
    await ctl({ emit: { type: 'session.idle', properties: { sessionID: SID } } });
    check('D', 'thinking indicator clears on idle', await pollGone(page, '.tabpane[style*="flex"] .footer .status_indicator.thinking'));

    // ---- F. a FAILED summary (from /session/status) keeps its own box --------
    // Guards the running-vs-failed branch split: a running compaction with no
    // engine telemetry must NOT fall through to the failure box.
    console.log('\nCASE F — /session/status compaction failure shows the failed box');
    await ctl({ status: { [SID]: { compaction: { state: 'failed', reason: 'not enough context to summarise', at: Date.now() } } } });
    const failBox = pane.locator('.cmpbox.failed'); // sidebar's 10s status poll delivers it
    await failBox.waitFor({ timeout: 15000 });
    const fTxt = (await failBox.textContent()) ?? '';
    check('F', 'failure box names the failure', /Compaction failed/.test(fTxt), `text: ${fTxt.trim()}`);
    check('F', 'failure box carries the reason', /not enough context/.test(fTxt), `text: ${fTxt.trim()}`);
    check('F', 'no footer indicator for a finished compaction', (await footer.locator('.status_indicator').count()) === 0);
    await ctl({ status: {} });
    await failBox.locator('.cmpdismiss').click();
    check('F', 'dismiss clears the failure box', await pollGone(page, '.tabpane[style*="flex"] .cmpbox.failed'), 'dismissed');

    // ---- G. narrow viewport: truncate, don't push ctrl+p out of the pane -----
    console.log('\nCASE G — narrow viewport keeps the footer inside its box');
    await page.setViewportSize({ width: 340, height: 640 });
    // The fixture booted on desktop, so the info panel is open and both side
    // panels squeeze the tabpane to ~0 width — close them to reach the mobile
    // layout the app actually shows (sidebar/panel default closed on mobile boot).
    // evaluate-click: at 340px the panels overlap the toggles, so real
    // hit-testing can't reach them (the store toggles are what we're after).
    if (await page.locator('aside.panel').count())
      await page.locator('.burger[title="Toggle info panel"]').evaluate((el) => el.click());
    if (await page.locator('.app:not(.nosidebar)').count())
      await page.locator('.burger[title="Toggle sidebar"]').evaluate((el) => el.click());
    await ctl({ emit: { type: 'session.next.compaction.started', properties: { sessionID: SID, messageID: 'msg_comp3', reason: 'auto', timestamp: Date.now() } } });
    await indicator.waitFor({ timeout: 5000 });
    const fit = await footer.evaluate((el) => {
      const btn = el.querySelector('.cmd')?.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return {
        sw: el.scrollWidth,
        cw: el.clientWidth,
        btnInside: !!btn && btn.right <= r.right + 0.5 && btn.left >= r.left - 0.5,
      };
    });
    check('G', 'footer has no horizontal overflow', fit.sw <= fit.cw, JSON.stringify(fit));
    check('G', 'ctrl+p button still inside the footer', fit.btnInside, JSON.stringify(fit));
    await footer.screenshot({ path: path.join(SHOTS_DIR, 'footer-narrow.png') });
    // Where does the 3-zone squeeze stop working? overlap = label's right edge
    // past the ctrl+p button's left edge (diagnostic + a floor at 480px).
    for (const w of [340, 390, 480, 620]) {
      await page.setViewportSize({ width: w, height: 640 });
      await sleep(120);
      const squeeze = await footer.evaluate((el) => {
        const q = (s) => el.querySelector(s)?.getBoundingClientRect();
        const ind = q('.status_indicator');
        const cmd = q('.cmd');
        const seg = [...el.querySelectorAll('.seg')];
        return {
          overlap: !!ind && !!cmd && ind.right > cmd.left,
          labelClippedTo: ind ? Math.round(ind.width) : null,
          segClipped: seg.some((n) => n.scrollWidth > n.clientWidth + 1),
        };
      });
      console.log(`  width ${w}: ${JSON.stringify(squeeze)}`);
      check('G', `no label/button overlap at ${w}px`, squeeze.overlap === false, JSON.stringify(squeeze));
    }
    await page.setViewportSize({ width: 340, height: 640 });
    await footer.screenshot({ path: path.join(SHOTS_DIR, 'footer-narrow-340.png') });
    await ctl({ emit: { type: 'session.idle', properties: { sessionID: SID } } });
    await page.setViewportSize({ width: 1280, height: 800 });

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
