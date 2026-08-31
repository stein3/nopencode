// stream-dup.test.mjs — headless regression for the delta-snapshot
// duplication bug: a message.part.delta still in the coalescing buffer
// when its message.part.updated snapshot arrives gets appended on top,
// producing a duplicated suffix until stream end.
//
// Fix applied in webui/src/lib/sse.ts: dropBufferedDeltas() is called
// before upsertPart in the message.part.updated handler.
//
// Scenario (deterministic race):
//   1. Fake engine serves one session (A user msg + in-progress assistant
//      msg with a text part seeded with a prefix).
//   2. Browser opens the session.
//   3. Emit message.part.delta (chunk), then IMMEDIATELY emit
//      message.part.updated (full snapshot = prefix + chunk). The snapshot
//      calls dropBufferedDeltas → the pending delta flush becomes a no-op.
//      Pre-fix: flush at +40ms appends the chunk a second time → duplicate.
//   4. Also verify the normal delta-only path still accumulates.
//
// NOTE: the webui's message.part.delta handler falls through to the catch-all
// scheduleRefetch (350ms debounce) which fetches GET /message. The fake engine
// must track live message state so the refetch returns current text (matching
// real engine behavior).
//
// Run:  node e2e/embedded/stream-dup.test.mjs

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, SHOTS_DIR, launchBrowser, screenshot, sleep, poll } from '../helpers/setup.mjs';

const PORT = Number(process.env.PORT) || 8168;
const BASE = `http://127.0.0.1:${PORT}`;
const SID = 'ses_stmdup01';

// ============================== fake engine =================================

const sseClients = new Set();
function sseEmit(type, properties = {}) {
  const frame = `data: ${JSON.stringify({ type, properties })}\n\n`;
  for (const res of sseClients) {
    try { res.write(frame); } catch { /* dropped client */ }
  }
}

const T0 = Date.now() - 60_000;

// Seeded transcript: one user message + one in-progress assistant message
// with a text part whose initial text is the prefix.
const PREFIX = 'Here is my analysis of the codebase: ';
const CHUNK = 'swept in. The untracked nopencode.png isn\'t from this session, so it stays out.';
const FULL_TEXT = PREFIX + CHUNK;
const EXTRA_A = ' ABC';
const EXTRA_B = ' DEF';

const MESSAGES = [
  {
    info: { id: 'msg_u1', role: 'user', agent: 'orchestrator', time: { created: T0 } },
    parts: [{ id: 'part_u1', type: 'text', text: 'Please analyze this code' }],
  },
  {
    info: {
      id: 'msg_a1',
      role: 'assistant',
      agent: 'orchestrator',
      modelID: 'ox-alpha-free',
      providerID: 'opencode-go',
      sessionID: SID,
      parentID: 'msg_u1',
      time: { created: T0 + 1000 },
    },
    parts: [{ id: 'part_a1', type: 'text', text: PREFIX }],
  },
];

// The fake engine MUST track live message state. The webui's message.part.delta
// handler falls through to a catch-all scheduleRefetch (350ms debounce) which
// fetches GET /session/{id}/message. We mirror SSE-applied changes so the
// refetch returns current text (matching real engine behavior).
const liveMessages = JSON.parse(JSON.stringify(MESSAGES));

function applySnapshotToLive(part) {
  for (const m of liveMessages) {
    if (m.info.id !== part.messageID) continue;
    const pi = m.parts.findIndex((p) => p.id === part.id);
    if (pi >= 0) m.parts[pi] = { ...m.parts[pi], ...part };
    else m.parts.push(part);
    return;
  }
}
function applyDeltaToLive(messageID, partID, field, delta) {
  for (const m of liveMessages) {
    if (m.info.id !== messageID) continue;
    for (const p of m.parts) {
      if (p.id !== partID) continue;
      if (field === 'text' || field === undefined) p.text = (p.text ?? '') + delta;
    }
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
  try {
    if (p === '/__state') return json(res, { liveMessages });
    if (p === '/__ctl') {
      const ctl = JSON.parse((await readBody(req)) || '{}');
      if (ctl.emit) {
        sseEmit(ctl.emit.type, ctl.emit.properties ?? {});
        // Mirror SSE-applied changes to the live message state so the
        // scheduleRefetch GET /message returns current text.
        const prop = ctl.emit.properties ?? {};
        if (ctl.emit.type === 'message.part.updated' && prop.part?.id) {
          applySnapshotToLive(prop.part);
        }
        if (ctl.emit.type === 'message.part.delta' && prop.partID && typeof prop.delta === 'string') {
          applyDeltaToLive(prop.messageID, prop.partID, prop.field, prop.delta);
        }
      }
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
    if (p.startsWith('/oc/session/') && p.endsWith('/prompt_async') && req.method === 'POST') {
      await readBody(req);
      res.writeHead(204);
      res.end();
      return;
    }
    if (p === '/api/history/sessions')
      return json(res, [
        {
          id: SID,
          title: 'stream-dup-probe',
          created: T0,
          updated: Date.now(),
          message_count: MESSAGES.length,
          cost: 0,
        },
      ]);
    if (p.endsWith('/errors')) {
      if (req.method === 'GET') return json(res, []);
      return json(res, { ok: true });
    }
    if (p.startsWith('/api/history/session/')) return json(res, []);
    if (p === '/oc/session/status') return json(res, {});
    // Return LIVE messages so scheduleRefetch refetches current state
    if (p.startsWith('/oc/session/') && p.endsWith('/message'))
      return json(res, liveMessages);
    if (p.startsWith('/oc/session/'))
      return json(res, { id: SID, title: 'stream-dup-probe', revert: null });
    if (p === '/oc/config/providers')
      return json(res, {
        providers: [{ id: 'opencode', models: { 'ox-alpha-free': { id: 'ox-alpha-free' } } }],
      });
    if (p === '/oc/path') return json(res, { directory: '/workspace' });
    if (p === '/oc/mcp') return json(res, {});
    if (p.startsWith('/oc/')) return json(res, []);

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
    } catch {
      /* headers already sent (SSE) */
    }
  }
});

// ================================ checks ====================================

const results = [];
let pageErrors = [];
function check(c, name, pass, note = '') {
  results.push({ c, name, pass: !!pass, note });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${c} · ${name}${note ? ` — ${note}` : ''}`);
}
const ctl = (payload) =>
  fetch(`${BASE}/__ctl`, { method: 'POST', body: JSON.stringify(payload) }).then((r) => r.json());

/**
 * Read the rendered text of the assistant message from the DOM.
 * The text lives in the .body div inside the .msg row (markdown-rendered <p>).
 */
async function readAssistantText(page, pane) {
  const row = pane.locator('#m-msg_a1');
  const text = await row.locator('.body').innerText().catch(() => '');
  return text;
}

// ================================ run =======================================

try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const pane = page.locator('.tabpane[style*="flex"]');

  try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.locator('.sidebar button.item', { hasText: 'stream-dup-probe' }).waitFor({ timeout: 15000 });
    await pane.locator('.msg', { hasText: 'Please analyze this code' }).first().waitFor({ timeout: 15000 });

    // ---- CASE A: delta + snapshot race → no duplicated suffix ---------------
    console.log('\nCASE A — delta + snapshot race: snapshot must not cause duplication');

    // Verify initial state — prefix only (may be trimmed by innerText)
    const initialText = await readAssistantText(page, pane);
    check('A', 'initial assistant text is prefix', initialText.includes('analysis of the codebase'), initialText.slice(0, 80));

    // Emit message.part.delta with our chunk
    await ctl({
      emit: {
        type: 'message.part.delta',
        properties: {
          sessionID: SID,
          messageID: 'msg_a1',
          partID: 'part_a1',
          field: 'text',
          delta: CHUNK,
        },
      },
    });

    // Emit message.part.updated IMMEDIATELY (same tick) with full snapshot.
    // This must arrive before the 40ms flush timer fires the buffered delta.
    await ctl({
      emit: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_a1',
            messageID: 'msg_a1',
            sessionID: SID,
            type: 'text',
            text: FULL_TEXT,
          },
        },
      },
    });

    // Wait past the 40ms flush timer — if the fix is missing, the buffered
    // delta will flush and append CHUNK a second time on top of the snapshot.
    await sleep(200);

    const raceText = await readAssistantText(page, pane);
    // Full text must be present (prefix + chunk, no duplication)
    check('A', 'rendered text equals full prefix+chunk', raceText.trim() === FULL_TEXT.trim(), raceText.slice(0, 120));

    // The chunk must appear exactly once — pre-fix it would appear twice
    const chunkEsc = CHUNK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const chunkCount = (raceText.match(new RegExp(chunkEsc, 'g')) || []).length;
    check('A', 'chunk appears exactly once (no duplication)', chunkCount === 1, `count=${chunkCount}`);

    // Explicitly: no double-chunk substring
    check('A', 'no double-chunk substring', !raceText.includes(CHUNK + CHUNK), raceText.slice(0, 200));

    // The text must end with the chunk (suffix position preserved)
    check('A', 'text ends with the chunk', raceText.trim().endsWith(CHUNK.trim()), raceText.slice(-80));

    await screenshot(page, 'stream-dup-race');

    // ---- CASE B: pure delta-only path still accumulates ----------------------
    console.log('\nCASE B — pure delta-only path still accumulates correctly');

    // Emit two more deltas with NO following snapshot
    await ctl({
      emit: {
        type: 'message.part.delta',
        properties: {
          sessionID: SID,
          messageID: 'msg_a1',
          partID: 'part_a1',
          field: 'text',
          delta: EXTRA_A,
        },
      },
    });
    await ctl({
      emit: {
        type: 'message.part.delta',
        properties: {
          sessionID: SID,
          messageID: 'msg_a1',
          partID: 'part_a1',
          field: 'text',
          delta: EXTRA_B,
        },
      },
    });

    // Wait for the 40ms flush timer to fire and apply both deltas
    await sleep(150);

    const accumText = await readAssistantText(page, pane);
    // After snapshot (PREFIX+CHUNK) + two deltas (EXTRA_A, EXTRA_B),
    // the text should be PREFIX+CHUNK+EXTRA_A+EXTRA_B
    const expectedFull = FULL_TEXT + EXTRA_A + EXTRA_B;
    check('B', 'accumulated text equals snapshot+extras', accumText.trim() === expectedFull.trim(), accumText.slice(-140));
    check('B', 'text includes EXTRA_A', accumText.includes(EXTRA_A), accumText.slice(-140));
    check('B', 'text includes EXTRA_B', accumText.includes(EXTRA_B), accumText.slice(-140));
    // Still no duplication of the original chunk
    check('B', 'original chunk still appears only once', (accumText.match(new RegExp(chunkEsc, 'g')) || []).length === 1);

    await screenshot(page, 'stream-dup-accum');

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
