// verify-agent-label.mjs — assistant message headers show the engine-stamped
// per-message `agent` (titlecased: build→Build, orchestrator→Orchestrator),
// preserved through ALL message pipelines (sse.ts normalizeMessages refetch,
// stores upsertPart/setMeta, App.svelte pure-history mapper), and the label
// SURVIVES a page reload — the regression that motivated the fix (the old
// normalizeMessages dropped `agent`, so labels fell back to 'opencode' after
// every refetch/reload).
//
// Prereq (started by the caller, NOT by this script):
//   OC_ENGINE=127.0.0.1:4096 PORT=8123 HOST=127.0.0.1 python3 /workspace/opencode/chatserver.py &
import { BASE, launchBrowser, createChecker } from '../helpers/setup.mjs'

const { check, summary } = createChecker()

async function api(p) {
  const r = await fetch(BASE + p);
  if (!r.ok) throw new Error(`GET ${p} -> ${r.status}`);
  return r.json();
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

let browser;
try {
  await main();
} catch (e) {
  console.log('ERROR:', e.message ?? e);
} finally {
  if (browser) await browser.close().catch(() => {});
  // no probe sessions created (assistant turns can't be seeded cheaply) —
  // nothing to clean up
  process.exit(summary());
}

async function main() {
  // ---- pick 2 real sessions whose assistant messages carry DIFFERENT
  //      non-empty agent values. Root sessions only (subagents are hidden in
  //      the sidebar by default), small enough that the whole transcript fits
  //      the newest-80 window, quote-free titles for attribute selectors.
  const sessions = (await api('/api/history/sessions'))
    .filter((s) => !s.parent && s.message_count >= 2 && s.message_count <= 80)
    .filter((s) => s.title && !s.title.startsWith('New session -') && !s.title.includes('"') && !s.title.includes('\\'))
    .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));

  const picked = [];
  const seenAgents = new Set();
  for (const s of sessions.slice(0, 40)) {
    let msgs;
    try {
      msgs = await api(`/api/history/session/${s.id}`);
    } catch {
      continue;
    }
    const assistants = msgs.filter((m) => m.role === 'assistant');
    const agents = [...new Set(assistants.map((m) => (m.agent || '').trim()).filter(Boolean))];
    // single-agent session with a meaningful (non-'opencode') label renders
    // the sharpest assertion; skip sessions whose rows would legitimately say
    // something else mid-transcript
    if (!assistants.length || agents.length !== 1 || agents[0] === 'opencode') continue;
    if (seenAgents.has(agents[0])) continue;
    if (picked.some((p) => p.title === s.title)) continue;
    seenAgents.add(agents[0]);
    picked.push({ ...s, agent: agents[0], msgs });
    if (picked.length === 2) break;
  }
  if (picked.length < 2) {
    console.log(
      `SKIP: fewer than 2 qualifying sessions found (${picked.length}) — need real ` +
        `sessions whose assistant messages carry distinct non-empty agent values`,
    );
    return; // exit 0 via finally
  }
  console.log(
    'sessions:',
    picked.map((p) => `${p.id} agent=${p.agent} msgs=${p.message_count}`).join(' | '),
  );

  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1900 } }); // tall: content-visibility keeps rows painted
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('.sidebar .item', { timeout: 10000 });
  await page.waitForTimeout(1200);

  const pane = page.locator('.tabpane[style*="flex"]'); // active pane only

  // open one session and assert every rendered row's label against the API
  async function assertSession(s, tag) {
    await page.click(`.sidebar .item[title="${s.title}"]`);
    // wait for the REAL message row (sidecar `.msg.errtile` tiles also have
    // class .msg and can render before the transcript fetch lands)
    const anyAssistant = s.msgs.find((m) => m.role === 'assistant');
    await pane.locator(`#m-${anyAssistant.id}`).waitFor({ timeout: 20000 });
    // let the debounced SSE refetch (scheduleRefetch → applyMessages →
    // normalizeMessages — THE fixed pipeline) replace the initial payload
    await page.waitForTimeout(1500);

    const rows = pane.locator('.msg:not(.errtile)');
    const n = await rows.count();
    check(`[${tag}] rows rendered`, n > 0, `${n} rows`);
    let checkedAssistant = 0;
    let badOpenCode = 0;
    for (let i = 0; i < n; i++) {
      const row = rows.nth(i);
      const id = await row.getAttribute('id');
      const m = s.msgs.find((x) => x.id === id?.replace(/^m-/, ''));
      if (!m) continue; // rendered row outside the fetched history snapshot
      const got = ((await row.locator('.role').textContent()) ?? '').trim();
      const want = uiLabel(m);
      if (m.role !== 'user') checkedAssistant++;
      const ok = got === want;
      if (!ok) check(`[${tag}] #${id} label`, false, `got "${got}" want "${want}"`);
      if (m.role !== 'user' && got === 'opencode' && m.agent !== 'opencode') badOpenCode++;
    }
    check(
      `[${tag}] all assistant labels = titlecased "${s.agent}"`,
      checkedAssistant > 0 && badOpenCode === 0,
      `${checkedAssistant} assistant rows checked`,
    );
    // explicit regression assertion: no bare lowercase fallback anywhere
    const roles = await pane.locator('.msg:not(.errtile) .role').allTextContents();
    check(
      `[${tag}] no bare 'opencode' fallback label`,
      !roles.map((t) => t.trim()).includes('opencode'),
    );
  }

  // ---- [1] fresh open (openLive → oc.messages → normalizeMessages)
  await assertSession(picked[0], '1');
  await assertSession(picked[1], '2');

  // ---- [2] RELOAD → re-open → labels must persist (the reported regression:
  //      they used to fall back to 'opencode' after every reload)
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sidebar .item', { timeout: 10000 });
  await page.waitForTimeout(1200);
  await assertSession(picked[0], 'reload-1');
  await assertSession(picked[1], 'reload-2');
}
