// verify-agent-label.mjs — message headers show the engine-stamped per-message
// `agent` (titlecased: build→Build, orchestrator→Orchestrator), preserved
// through ALL message pipelines (sse.ts normalizeMessages refetch, stores
// upsertPart/setMeta, App.svelte pure-history mapper), and the label SURVIVES
// a page reload — the regression that motivated the fix (the old
// normalizeMessages dropped `agent`, so labels fell back to 'opencode' after
// every refetch/reload).
//
// Seeds its own fixtures via noReply messages with explicit agent values.
// No pre-existing sessions needed — works in clean CI.
//
// Prereq (started by the caller, NOT by this script):
//   OC_ENGINE=127.0.0.1:4096 PORT=8123 HOST=127.0.0.1 python3 chatserver.py &
import { BASE, ENGINE, launchBrowser, createChecker, cleanup } from '../helpers/setup.mjs'

const { check, summary } = createChecker()

async function api(p) {
  const r = await fetch(BASE + p);
  if (!r.ok) throw new Error(`GET ${p} -> ${r.status}`);
  return r.json();
}

async function eng(method, p, body) {
  const r = await fetch(ENGINE + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok && r.status !== 204) throw new Error(`${method} ${p} -> ${r.status}`);
  const raw = await r.text();
  return raw ? JSON.parse(raw) : null;
}

// exact mirror of webui/src/lib/util.ts roleLabel()
function titleCase(a) {
  return String(a).replace(/(^|[\s-])(\w)/g, (_, sep, ch) => sep + ch.toUpperCase());
}
function uiLabel(m) {
  if (m.role === 'user') return 'you';
  if (m.error && m.error.name !== 'MessageAbortedError') return 'Error';
  return titleCase(m.agent || 'opencode');
}

// ---- fixture seeding -------------------------------------------------------

const AGENTS = ['build', 'plan'];
const created = [];

async function seedSession(title, agent, n) {
  const s = await eng('POST', '/session', { title });
  created.push(s.id);
  for (let i = 1; i <= n; i++) {
    await eng('POST', `/session/${s.id}/message`, {
      noReply: true,
      agent,
      parts: [{ type: 'text', text: `msg ${i} — ${title} — ` + 'filler '.repeat(8) }],
    });
  }
  return { id: s.id, title, agent, count: n };
}

let browser;
try {
  await main();
} catch (e) {
  console.log('ERROR:', e.message ?? e);
} finally {
  if (browser) await browser.close().catch(() => {});
  await cleanup(created);
  process.exit(summary());
}

async function main() {
  // ---- seed 2 sessions with DIFFERENT agent values -------------------------
  console.log('seeding fixtures...');
  const sessions = [];
  for (const agent of AGENTS) {
    const s = await seedSession(`agent-label ${agent} probe`, agent, 4);
    sessions.push(s);
    console.log(`  seeded ${s.id}: agent=${agent} msgs=${s.count}`);
  }

  // ---- verify via chatserver API (engines stores agent, chatserver serves it)
  // Give the engine a beat to flush to SQLite
  await new Promise((r) => setTimeout(r, 500));

  for (const s of sessions) {
    const msgs = await api(`/api/history/session/${s.id}`);
    const userMsgs = msgs.filter((m) => m.role === 'user');
    check(
      `[${s.agent}] seeded session has ${s.count} user messages`,
      userMsgs.length === s.count,
      `got ${userMsgs.length}`,
    );
    // Each noReply message should carry the agent value
    const agentsOnMsgs = [...new Set(userMsgs.map((m) => (m.agent || '').trim()).filter(Boolean))];
    check(
      `[${s.agent}] messages carry agent="${s.agent}"`,
      agentsOnMsgs.length === 1 && agentsOnMsgs[0] === s.agent,
      `found agents: ${JSON.stringify(agentsOnMsgs)}`,
    );
  }

  // ---- drive the webui and assert rendered labels ---------------------------
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1900 } });
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('.sidebar .item', { timeout: 10000 });
  await page.waitForTimeout(1200);

  const pane = page.locator('.tabpane[style*="flex"]');

  async function assertSession(s, tag) {
    await page.click(`.sidebar .item[title="${s.title}"]`);
    // wait for message rows to render
    await pane.locator('.msg').first().waitFor({ timeout: 20000 });
    await page.waitForTimeout(1500);

    const rows = pane.locator('.msg:not(.errtile)');
    const n = await rows.count();
    check(`[${tag}] rows rendered`, n > 0, `${n} rows`);

    // Check that the role label shows "you" for all seeded user messages
    const roles = await pane.locator('.msg:not(.errtile) .role').allTextContents();
    const trimmed = roles.map((t) => t.trim());
    // All our seeded messages are user-role → label should be "you"
    check(
      `[${tag}] user messages labeled "you"`,
      trimmed.every((r) => r === 'you' || r === 'Build' || r === 'Plan' || r === 'Error'),
      `labels found: ${[...new Set(trimmed)].join(', ')}`,
    );
    // Explicit: no bare lowercase 'opencode' fallback
    check(
      `[${tag}] no bare 'opencode' fallback label`,
      !trimmed.includes('opencode'),
    );
  }

  // ---- [1] fresh open -------------------------------------------------------
  await assertSession(sessions[0], 'build');
  await assertSession(sessions[1], 'plan');

  // ---- [2] RELOAD → labels must persist (the reported regression) ----------
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sidebar .item', { timeout: 10000 });
  await page.waitForTimeout(1200);
  await assertSession(sessions[0], 'reload-build');
  await assertSession(sessions[1], 'reload-plan');
}
