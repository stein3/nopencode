// verify-tasknotice.mjs — headless regression for subagent task-result rows
// (engine-injected synthetic user messages). Embedded fake engine, same
// conventions as verify-stall-retry.mjs / verify-question.mjs: serve
// webui/dist + stub /oc endpoints + scripted SSE via /__ctl + /__state.
//
// Engine shape under test (verified against live engine v1.18.18 + opencode.db):
//   user-role message, single text part { synthetic: true, text:
//   "<task id=\"ses_…\" state=\"completed|error\">\n<summary>Background task
//   completed|failed: DESC</summary>\n<task_result>…</task_result>\n</task>" }
//
// Cases:
//   A. REST payload render: notices get .subres (pink) / .suberr (red),
//      header "✓|✗ subagent" + description, NEVER "you"/.user, no ↩⑂🗑 acts,
//      real user rows unchanged
//   B. collapsed by default; clicking the summary expands full markdown;
//      screenshots (collapsed / expanded / error)
//   C. mid-turn SSE arrival (message.part.updated w/ raw synthetic part +
//      message.updated): renders as .subres too, and deriveQueued never badges
//      it "queued" while the turn is busy
//
// Run:  node e2e/embedded/tasknotice.test.mjs

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { DIST, SHOTS_DIR, launchBrowser, screenshot, sleep, poll } from '../helpers/setup.mjs';

const PORT = 8137;
const BASE = `http://127.0.0.1:${PORT}`;
const SID = 'ses_tasknote01';

// ============================== fake engine =================================

const sseClients = new Set();
function sseEmit(type, properties = {}) {
  const frame = `data: ${JSON.stringify({ type, properties })}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      /* dropped client */
    }
  }
}

const T0 = Date.now() - 300_000;

function taskText(state, desc, body) {
  return (
    `<task id="ses_child_${state}" state="${state}">\n` +
    `<summary>Background task ${state === 'error' ? 'failed' : 'completed'}: ${desc}</summary>\n` +
    (state === 'error' ? `<task_error>\n${body}\n</task_error>` : `<task_result>\n${body}\n</task_result>`) +
    `\n</task>`
  );
}

const RESULT_MD = [
  'Research complete. Here is the compact factual summary.',
  '',
  '## Findings',
  '',
  '- No major browser lets a normal tab capture Ctrl+W.',
  '- The standardized escape hatch is fullscreen keyboard lock.',
  '',
  '```ts',
  'export function onKey(e: KeyboardEvent) {',
  "  if (e.key === 'Home') scroller.scrollTop = 0",
  '}',
  '```',
  '',
  'Done.',
].join('\n');

// seeded transcript. msg_t3 joins LATER via the SSE path (case C).
const MESSAGES = [
  {
    info: { id: 'msg_u1', role: 'user', agent: 'orchestrator', time: { created: T0 } },
    parts: [{ id: 'part_u1', type: 'text', text: 'run the recon lane please' }],
  },
  {
    info: {
      id: 'msg_a1',
      role: 'assistant',
      agent: 'orchestrator',
      modelID: 'ox-alpha-free',
      providerID: 'opencode-go',
      time: { created: T0 + 1000 },
    },
    parts: [{ id: 'part_a1', type: 'text', text: 'Dispatching recon now.' }],
  },
  {
    // engine-injected COMPLETED task result — synthetic user message
    info: {
      id: 'msg_t1',
      role: 'user',
      agent: 'orchestrator',
      time: { created: T0 + 2000 },
    },
    parts: [
      {
        id: 'part_t1',
        type: 'text',
        synthetic: true,
        text: taskText('completed', 'Research Ctrl+W capture limits', RESULT_MD),
      },
    ],
  },
  {
    // engine-injected FAILED task result
    info: {
      id: 'msg_t2',
      role: 'user',
      agent: 'orchestrator',
      time: { created: T0 + 3000 },
    },
    parts: [
      {
        id: 'part_t2',
        type: 'text',
        synthetic: true,
        text: taskText('error', 'Design pass on a11y fixes', 'Session error'),
      },
    ],
  },
  {
    info: { id: 'msg_u2', role: 'user', agent: 'orchestrator', time: { created: T0 + 4000 } },
    parts: [{ id: 'part_u2', type: 'text', text: 'great, continue with the design' }],
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
    if (p === '/__state') return json(res, { messages: MESSAGES.length });
    if (p === '/__ctl') {
      const ctl = JSON.parse((await readBody(req)) || '{}');
      if (ctl.emit) sseEmit(ctl.emit.type, ctl.emit.properties ?? {});
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
          title: 'tasknotice-probe',
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
    if (p.startsWith('/oc/session/') && p.endsWith('/message')) return json(res, MESSAGES);
    if (p.startsWith('/oc/session/'))
      return json(res, { id: SID, title: 'tasknotice-probe', revert: null });
    if (p === '/oc/config/providers')
      return json(res, {
        providers: [{ id: 'opencode', models: { 'x-preview-f-free': { id: 'x-preview-f-free' } } }],
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

// ================================ run =======================================

try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const pane = page.locator('.tabpane[style*="flex"]');

  try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.locator('.sidebar button.item', { hasText: 'tasknotice-probe' }).waitFor({ timeout: 15000 });
    await pane.locator('.msg', { hasText: 'run the recon lane please' }).first().waitFor({ timeout: 15000 });

    const rowT1 = pane.locator('#m-msg_t1');
    const rowT2 = pane.locator('#m-msg_t2');
    const rowU1 = pane.locator('#m-msg_u1');

    // ---- A. REST payload render --------------------------------------------
    console.log('\nCASE A — completed + failed notices render as subagent rows, not "You"');
    await rowT1.waitFor({ timeout: 10000 });
    await rowT2.waitFor({ timeout: 10000 });

    const clsT1 = (await rowT1.getAttribute('class')) ?? '';
    check('A', 'completed notice row has .subres', clsT1.split(/\s+/).includes('subres'), clsT1);
    check('A', 'completed notice row is NOT .user', !clsT1.split(/\s+/).includes('user'), clsT1);
    const clsT2 = (await rowT2.getAttribute('class')) ?? '';
    check('A', 'failed notice row has .subres.suberr', clsT2.split(/\s+/).includes('subres') && clsT2.split(/\s+/).includes('suberr'), clsT2);

    // .role is CSS-uppercased — match case-insensitively
    const roleT1 = (await rowT1.locator('.role').innerText()).replace(/\s+/g, ' ').trim();
    check('A', 'header label "✓ subagent" (never "you")', /✓\s*subagent/i.test(roleT1) && !/\byou\b/i.test(roleT1), roleT1);
    const roleT2 = (await rowT2.locator('.role').innerText()).replace(/\s+/g, ' ').trim();
    check('A', 'failed label "✗ subagent"', /✗\s*subagent/i.test(roleT2), roleT2);

    const descT1 = (await rowT1.locator('.tnote-desc').innerText()).trim();
    check('A', 'description parsed from <summary>', descT1 === 'Research Ctrl+W capture limits', descT1);

    check('A', 'notice rows render NO revert/fork/delete actions', (await rowT1.locator('.act').count()) === 0 && (await rowT2.locator('.act').count()) === 0);
    const clsU1 = (await rowU1.getAttribute('class')) ?? '';
    check('A', 'real user row keeps .user + actions', clsU1.split(/\s+/).includes('user') && (await rowU1.locator('.act').count()) === 3);

    const borderT1 = await rowT1.evaluate((el) => getComputedStyle(el).borderLeftColor);
    check('A', 'completed border is agent pink #ec7ba4', borderT1 === 'rgb(236, 123, 164)', borderT1);
    const borderT2 = await rowT2.evaluate((el) => getComputedStyle(el).borderLeftColor);
    check('A', 'failed border is --err #f48771', borderT2 === 'rgb(244, 135, 113)', borderT2);
    const roleColT1 = await rowT1.locator('.role').evaluate((el) => getComputedStyle(el).color);
    check('A', 'subrole label colored pink (out-ranks accent rule)', roleColT1 === 'rgb(236, 123, 164)', roleColT1);

    await screenshot(page, 'tasknotice-collapsed');

    // ---- B. collapsed by default → click expands markdown -------------------
    console.log('\nCASE B — collapsed by default, summary expands to full markdown');
    const tnoteT1 = rowT1.locator('details.tnote');
    check('B', 'details.tnote present on notice body', (await tnoteT1.count()) === 1);
    const openBefore = await tnoteT1.evaluate((el) => el.open);
    check('B', 'collapsed by default (details.open false)', openBefore === false, String(openBefore));
    const bodyVisibleBefore = await tnoteT1.locator('.tnote-body').isVisible();
    check('B', 'result body hidden while collapsed', !bodyVisibleBefore);

    const tsum = (await tnoteT1.locator('.tsum').innerText()).trim();
    check('B', 'summary previews first content line', tsum.startsWith('Research complete'), tsum);
    const tcount = (await tnoteT1.locator('.tcount').innerText()).trim();
    check('B', 'char count shown', /[\d,]+ chars$/.test(tcount), tcount);

    await tnoteT1.locator('summary').first().click();
    const openAfter = await poll(() => tnoteT1.evaluate((el) => el.open));
    check('B', 'click expands the row', openAfter);
    const codeCount = await tnoteT1.locator('.tnote-body pre code').count();
    check('B', 'expanded body renders markdown incl. code fence', codeCount >= 1, `code blocks=${codeCount}`);
    const h2Count = await tnoteT1.locator('.tnote-body h2').count();
    check('B', 'expanded body renders headings', h2Count >= 1);
    // envelope must be stripped pre-markdown: <summary> survives DOMPurify as
    // a live element and would re-render the header line inside the body
    const envLeak = await tnoteT1.locator('.tnote-body summary').count();
    const envText = await tnoteT1.locator('.tnote-body').innerText();
    check('B', 'no <task>/<summary> envelope leak in expanded body', envLeak === 0 && !envText.includes('Background task'), `summaries=${envLeak}`);
    await screenshot(page, 'tasknotice-expanded');
    await rowT2.screenshot({ path: path.join(SHOTS_DIR, 'tasknotice-error.png') });

    // reload → back to collapsed (no persistence, per design)
    await page.reload({ waitUntil: 'domcontentloaded' });
    await rowT1.waitFor({ timeout: 15000 });
    check('B', 'reload resets to collapsed', (await rowT1.locator('details.tnote').evaluate((el) => el.open)) === false);

    // ---- C. mid-turn SSE arrival while busy → no queued badge ---------------
    console.log('\nCASE C — live SSE arrival during a busy turn: styled + never "queued"');
    MESSAGES.push({
      info: { id: 'msg_t3', role: 'user', agent: 'orchestrator', time: { created: Date.now() } },
      parts: [
        {
          id: 'part_t3',
          type: 'text',
          synthetic: true,
          text: taskText('completed', 'Implement webui hotkey features', 'All changes verified in place and build green.'),
        },
      ],
    });
    // optimistic busy via composer submit (same trigger as a real send)
    const input = pane.locator('#composer-input');
    await input.fill('ok go ahead');
    await input.press('Enter');
    // raw part event carries synthetic:true; message.updated follows, then the
    // debounced refetch materializes msg_t3 from GET /message
    await ctl({
      emit: {
        type: 'message.part.updated',
        properties: {
          part: { id: 'part_t3', messageID: 'msg_t3', sessionID: SID, type: 'text', synthetic: true, text: taskText('completed', 'Implement webui hotkey features', 'All changes verified in place and build green.') },
        },
      },
    });
    await ctl({
      emit: { type: 'message.updated', properties: { info: { id: 'msg_t3', sessionID: SID, role: 'user' } } },
    });
    const rowT3 = pane.locator('#m-msg_t3');
    const arrived = await poll(async () => {
      try {
        return (await rowT3.getAttribute('class'))?.split(/\s+/).includes('subres');
      } catch {
        return false;
      }
    }, 6000);
    check('C', 'SSE-arrived notice rendered as .subres', !!arrived);
    if (arrived) {
      const roleT3 = (await rowT3.locator('.role.subrole').innerText()).replace(/\s+/g, ' ').trim();
      check('C', 'live notice labeled "✓ subagent"', /✓\s*subagent/i.test(roleT3), roleT3);
      check('C', 'live notice collapsed by default', (await rowT3.locator('details.tnote').evaluate((el) => el.open)) === false);
    }
    await sleep(700); // cover refetch debounce settling
    const qbadges = await pane.locator('.qbadge').count();
    check('C', 'NO "queued" badge on any row while busy (notices excluded)', qbadges === 0, `qbadges=${qbadges}`);
    const clsU2 = (await pane.locator('#m-msg_u2').getAttribute('class')) ?? '';
    check('C', 'real queued-prompt row u2 also badge-free (head slot)', !clsU2.includes('has-qbadge'));
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
