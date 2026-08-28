// Verify the composer AgentPicker (per-message role dropdown) — PER-SESSION scope:
//   1. fresh state -> collapsed label "Auto", nothing persisted
//   2. menu lists exactly Auto + eligible agents from live GET /oc/agent
//      (mode !== 'subagent' && !hidden) — includes plugin primaries like
//      oh-my-opencode-slim's orchestrator, excludes subagents/hidden system
//   3. picking Plan sends top-level agent:"plan" on prompt_async
//   4. selection persists across reload (localStorage opencode.sessionAgents,
//      keyed by session id)
//   5. PER-SESSION ISOLATION: a second session starts Auto even while the
//      first has Plan; picks made on a pending tab survive realize (id rekey);
//      Auto on one session never touches another session's pick
//   6. picking Auto omits the agent field entirely
// Assumes chatserver already running at :8123 (fresh dist) + engine at :4096.
import { BASE, ENGINE, launchBrowser, createChecker } from '../helpers/setup.mjs'

const { check, summary } = createChecker()
const titleName = (s) =>
  s.replace(/(^|[\s-])(\w)/g, (_s, sep, ch) => sep + ch.toUpperCase())

// expected eligible roster straight from the engine (via chatserver proxy)
const roster = await (await fetch(BASE + '/oc/agent')).json()
const expected = (roster ?? [])
  .filter((a) => a.mode !== 'subagent' && !a.hidden)
  .map((a) => titleName(a.name))
console.log('eligible agents:', expected.join(', '))
check(expected.length >= 2, `engine has ${expected.length} selectable agents`)

const browser = await launchBrowser()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message))

const PANE = '.tabpane[style*="flex"]'
const trigger = () => page.locator(`${PANE} .toolbar .wrap button.cur`)
const menuRows = () => page.locator(`${PANE} .toolbar .wrap .menu button.m`)
const activeSid = () =>
  page.locator('.tabbar .tab.active').getAttribute('data-sid')
const gotoTab = async (sid) => {
  await page.locator(`.tabbar .tab[data-sid="${sid}"]`).click()
  await page.waitForTimeout(250)
}

await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)

// fresh state (also scrub the pre-2026-08 global key)
await page.evaluate(() => {
  localStorage.removeItem('opencode.agent')
  localStorage.removeItem('opencode.sessionAgents')
})
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)

// 1. collapsed default label
await trigger().waitFor({ state: 'visible', timeout: 5000 })
check(((await trigger().textContent()) ?? '').includes('Auto'), 'collapsed label defaults to "Auto"')

// 2. open menu, compare row set vs engine roster
await trigger().click()
await page.waitForSelector(`${PANE} .toolbar .wrap .menu button.m`)
const names = []
for (const r of await menuRows().all()) {
  const nm = ((await r.locator('.nm').textContent()) ?? '').trim()
  names.push(nm === 'Auto' ? 'Auto' : nm)
}
const extra = names.filter((n) => n !== 'Auto' && !expected.includes(n))
const missing = expected.filter((e) => !names.includes(e))
check(extra.length === 0, `no subagent/hidden leakage (extra: [${extra}])`)
check(missing.length === 0, `all eligible agents present (missing: [${missing}])`)
check(names[0] === 'Auto', 'Auto row pinned first')

// capture payloads + created sessions (pending-tab realize), mock prompts
const bodies = []
let createdSid = ''
await page.route('**/oc/session/*/prompt_async', (route) => {
  if (route.request().method() === 'POST') {
    try { bodies.push(route.request().postDataJSON()) } catch {}
    return route.fulfill({ status: 204, body: '' })
  }
  return route.fallback()
})
await page.route('**/oc/session', async (route) => {
  const r = route.request()
  if (r.method() === 'POST' && !r.url().endsWith('/session/')) {
    const resp = await route.fetch()
    try { createdSid = JSON.parse(await resp.text())?.id ?? '' } catch {}
    return route.fulfill({ response: resp, body: await resp.text() })
  }
  return route.fallback()
})
const send = async (text) => {
  const ta = page.locator('#composer-input:visible')
  await ta.fill(text)
  await ta.press('Enter')
  await page.waitForTimeout(600)
}

// 3. pick Plan on session A, send, capture payload
const sidA = await activeSid()
const planRow = page.locator(`${PANE} .toolbar .wrap .menu button.m`, { hasText: 'Plan' })
check(await planRow.count() === 1, 'exactly one Plan row')
await planRow.click()
check(((await trigger().textContent()) ?? '').includes('Plan'), 'collapsed label updates to "Plan"')
await send('agent picker probe one')
check(bodies.length === 1, `one prompt captured (${bodies.length})`)
check(bodies[0]?.agent === 'plan', `payload carries agent:"plan" (got ${JSON.stringify(bodies[0]?.agent)})`)

// 4. stickiness across reload (per-session persistence)
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)
if ((await activeSid()) !== sidA) await gotoTab(sidA)
check(((await trigger().textContent()) ?? '').includes('Plan'), 'label persists across reload')
await send('agent picker probe two')
check(bodies.length === 2 && bodies[1]?.agent === 'plan', 'second send after reload still carries agent:"plan"')

// 5a. PER-SESSION: a brand-new (pending) tab starts Auto despite A=Plan
await page.click('button.add')
await page.waitForTimeout(400)
check(((await trigger().textContent()) ?? '').includes('Auto'), 'new session starts Auto (no leak from session A)')

// 5b. pick Build on the PENDING tab, send -> realize keeps the pick
await trigger().click()
await page.waitForSelector(`${PANE} .toolbar .wrap .menu button.m`)
const buildRow = page.locator(`${PANE} .toolbar .wrap .menu button.m`, { hasText: 'Build' })
check(await buildRow.count() === 1, 'exactly one Build row')
await buildRow.click()
check(((await trigger().textContent()) ?? '').includes('Build'), 'pending tab label updates to "Build"')
await send('agent picker probe three')
check(!!createdSid, `pending tab realized into ${createdSid || '(none)'}`)
check(bodies.length === 3 && bodies[2]?.agent === 'build', 'post-realize send carries agent:"build"')
check(((await trigger().textContent()) ?? '').includes('Build'), 'label still "Build" after realize (pick migrated to real sid)')
const storedMap = await page.evaluate(() => JSON.parse(localStorage.getItem('opencode.sessionAgents') ?? '{}'))
check(storedMap[sidA] === 'plan' && storedMap[createdSid] === 'build', `localStorage map has per-session entries (A=plan, B=build): ${JSON.stringify(storedMap)}`)

// 5c. switch back to A: its Plan untouched by B's Build
await gotoTab(sidA)
check(((await trigger().textContent()) ?? '').includes('Plan'), 'switching tabs restores session A\'s own pick (Plan)')

// 5d. Auto on A must NOT touch B
await trigger().click()
await page.waitForSelector(`${PANE} .toolbar .wrap .menu button.m`)
await page.locator(`${PANE} .toolbar .wrap .menu button.m.auto`).click()
check(((await trigger().textContent()) ?? '').includes('Auto'), 'back to Auto on A')
await gotoTab(createdSid)
check(((await trigger().textContent()) ?? '').includes('Build'), 'session B unaffected by A going Auto (still Build)')
await send('agent picker probe four')
check(bodies.length === 4 && bodies[3]?.agent === 'build', 'send from B still carries agent:"build"')

// 6. Auto omits the field (on B this time)
await trigger().click()
await page.waitForSelector(`${PANE} .toolbar .wrap .menu button.m`)
await page.locator(`${PANE} .toolbar .wrap .menu button.m.auto`).click()
check(((await trigger().textContent()) ?? '').includes('Auto'), 'B back to Auto')
await send('agent picker probe five')
check(bodies.length === 5 && !('agent' in bodies[4]), 'Auto send omits agent field entirely')

// cleanup: probe session created by the pending-tab realize
if (createdSid) {
  await fetch(`${ENGINE}/session/${createdSid}`, { method: 'DELETE' }).catch(() => {})
  console.log('cleaned up probe session ' + createdSid)
}
await page.evaluate(() => localStorage.removeItem('opencode.sessionAgents'))

await browser.close()
process.exit(summary())
