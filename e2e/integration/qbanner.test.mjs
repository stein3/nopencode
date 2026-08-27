// Smoke for the "questions pending" banner (QuestionBanner.svelte):
//  - appears only while GET /oc/question holds a pending request for THIS session
//  - copy: "<n> questions awaiting your answer · <first header>"
//  - click scrolls the question card's message row into view (Tab.jumpTo)
//  - disappears when the pending list drains (SSE drop -> refreshQuestions)
// Route-mocks ONLY /oc/question*; everything else hits the real chatserver.
import path from 'node:path';
import { BASE, ENGINE, launchBrowser, screenshot, SHOTS_DIR, REPO_ROOT } from '../helpers/setup.mjs'

let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}`);
  if (!cond) failures++;
};

// ---- seed a probe session with filler rows + two jump targets ------------
const ses = await fetch(`${ENGINE}/session`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'Question banner smoke' }),
}).then((r) => r.json());
const SID = ses.id;
async function seed(text) {
  const m = await fetch(`${ENGINE}/session/${SID}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ noReply: true, parts: [{ type: 'text', text }] }),
  }).then((r) => r.json());
  return m.id ?? m.info?.id;
}
for (let i = 1; i <= 24; i++) await seed(`filler row ${i} — keep the transcript taller than the viewport`);
const M1 = await seed('target row one (first pending question)');
const M2 = await seed('target row two (second pending question)');
console.log('seeded', SID, M1, M2);

// ---- mocks ----------------------------------------------------------------
let qPayload = [
  {
    id: 'qbann-1',
    sessionID: SID,
    questions: [{ header: 'Deployment target 1', question: 'Where should we deploy?', options: [{ label: 'staging' }, { label: 'prod' }] }],
    tool: { messageID: M1, callID: 'call_1' },
  },
  {
    id: 'qbann-2',
    sessionID: SID,
    questions: [{ header: 'Deployment target 2', question: 'And the second one?', options: [{ label: 'a' }] }],
    tool: { messageID: M2, callID: 'call_2' },
  },
];

const browser = await launchBrowser();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

await page.route('**/oc/question', (route) => {
  if (route.request().method() !== 'GET') return route.fallback();
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(qPayload) });
});
await page.route('**/oc/question/*/reply', (route) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
);

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });

// probe session was created last -> auto-opened as most recent root
const banner = page.locator('.tabpane[style*="flex"] .qbanner');
await banner.waitFor({ timeout: 10000 });
const txt = (await banner.textContent()) ?? '';
ok(/2 questions awaiting your answer/.test(txt), `count copy (${txt.trim().slice(0, 60)}…)`);
ok(txt.includes('Deployment target 1'), 'shows FIRST request header');
ok(!txt.includes('!'), 'no exclamation marks');

await screenshot(page, 'qbanner');

// ---- scroll away from the bottom rows (real wheel: clears stick-to-bottom)
const pane = page.locator('.tabpane[style*="flex"] .transcript');
const pb = await pane.boundingBox();
await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
await page.mouse.wheel(0, -900);
await page.waitForTimeout(400);
const before = await page.locator(`#m-${M1}`).boundingBox();
ok(!before || before.y >= 800 || before.y < 0, `target row offscreen after wheel-up (y=${before?.y})`);

// ---- click jumps to the first pending question's card row -----------------
await banner.click();
await page.waitForTimeout(700);
const after = await page.locator(`#m-${M1}`).boundingBox();
ok(after && after.y >= 0 && after.y < 800, `jump parked target row in view (y=${after?.y})`);
await screenshot(page, 'qbanner-jumped');

// ---- store-driven disappearance: drain the list, then drop the SSE pipe ----
// (context.setOffline can't break localhost connections in Chromium, so kill
// the stateless chatserver instead — EventSource errors, sse.ts re-pulls
// questions on reconnect, and the mock now returns []. Restarted at the end.)
import { execSync, spawn } from 'node:child_process';
qPayload = [];
execSync("pkill -f '[c]hatserver.py'");
let gone = false;
for (let i = 0; i < 30; i++) {
  if ((await page.locator('.qbanner').count()) === 0) { gone = true; break; }
  await page.waitForTimeout(500);
}
ok(gone, 'banner disappears once nothing pends');

await browser.close();

// bring the local loop back up for whoever runs next
const chatserverPath = path.join(REPO_ROOT, 'chatserver.py');
spawn('python3', [chatserverPath], {
  cwd: REPO_ROOT,
  env: { ...process.env, OC_ENGINE: '127.0.0.1:4096', PORT: '8123', HOST: '127.0.0.1' },
  detached: true,
  stdio: 'ignore',
}).unref();
for (let i = 0; i < 20; i++) {
  try {
    await fetch(`${BASE}/api/history/sessions`);
    console.log('chatserver restarted on :8123');
    break;
  } catch { await new Promise((r) => setTimeout(r, 500)); }
}

// ---- cleanup probe session -------------------------------------------------
await fetch(`${ENGINE}/session/${SID}`, { method: 'DELETE' });
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);
