// AgentPicker verification: roster filter, upward menu, sticky pref,
// payload wiring, Esc/click-outside, mobile compactness.
// Uses the live local loop (chatserver :8123 -> engine :4096); intercepts
// POST */prompt_async so NO real LLM turn fires. Deletes probe sessions.
import { BASE, ENGINE, launchBrowser, createChecker, screenshot, SHOTS_DIR } from '../helpers/setup.mjs'

const { check, summary } = createChecker()

const browser = await launchBrowser()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message))

// --- intercepts -----------------------------------------------------------
const promptBodies = []
const sessionIds = new Set()
await page.route('**/oc/session/*/prompt_async', async (route) => {
  if (route.request().method() === 'POST') {
    try {
      promptBodies.push(JSON.parse(route.request().postData() ?? '{}'))
    } catch {}
    return route.fulfill({ status: 204, body: '' })
  }
  return route.fallback()
})
await page.route('**/oc/session', async (route) => {
  const r = route.request()
  if (r.method() === 'POST' && !r.url().endsWith('/session/')) {
    const resp = await route.fetch()
    try {
      const body = JSON.parse(await resp.text())
      if (body?.id) sessionIds.add(body.id)
    } catch {}
    return route.fulfill({ response: resp, body: await resp.text() })
  }
  return route.fallback()
})

// --- fresh state ----------------------------------------------------------
await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1200)
await page.evaluate(() => {
  localStorage.removeItem('opencode.agent')
  localStorage.removeItem('opencode.sessionAgents')
})
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)

// fresh pending tab so realize() creates a trackable session
await page.click('button.add')
await page.waitForTimeout(400)

const pane = page.locator('.tabpane[style*="flex"]')
const pickerBtn = pane.locator('.toolbar .wrap:first-child .cur')

// 1. collapsed default label
check((await pickerBtn.textContent())?.trim().startsWith('Auto'), 'collapsed label defaults to "Auto"')

// 2. open menu: eligible rows only, engine order preserved
await pickerBtn.click()
const agentMenu = pane.locator('.wrap .menu')
await agentMenu.waitFor({ state: 'visible', timeout: 5000 })
const names = []
for (const r of await agentMenu.locator('.m').all()) {
  names.push(((await r.locator('.nm').textContent()) ?? '').trim())
}
const expected = ['Auto', 'Orchestrator', 'Build', 'Plan']
check(
  names.length === expected.length && expected.every((n, i) => names[i] === n),
  `roster = ${JSON.stringify(names)} (default-first order, Auto row first)`,
)
const bad = names.filter((n) =>
  ['Explore', 'Explorer', 'Oracle', 'Designer', 'Fixer', 'Librarian', 'Observer', 'Councillor', 'Compaction', 'Title', 'Summary'].includes(n),
)
check(bad.length === 0, `no subagents/hidden in list (found: ${JSON.stringify(bad)})`)

// 3. menu opens UPWARD above the button
const bb = await pickerBtn.boundingBox()
const mb = await agentMenu.boundingBox()
check(bb && mb && mb.y + mb.height <= bb.y + 2, `menu sits above the button (menu bottom ${mb ? Math.round(mb.y + mb.height) : '?'}, btn top ${bb ? Math.round(bb.y) : '?'})`)

// 4. Esc closes
await page.keyboard.press('Escape')
await page.waitForTimeout(150)
check((await agentMenu.count()) === 0, 'Escape closes the menu')

// 5. click-outside closes
await pickerBtn.click()
await agentMenu.waitFor({ state: 'visible', timeout: 5000 })
await pane.locator('#composer-input').click()
await page.waitForTimeout(150)
check((await agentMenu.count()) === 0, 'click-outside closes the menu')

// 6. pick Plan -> label + localStorage
await pickerBtn.click()
await agentMenu.waitFor({ state: 'visible', timeout: 5000 })
await agentMenu.locator('.m', { hasText: 'Plan' }).first().click()
await page.waitForTimeout(150)
check((await pickerBtn.textContent())?.trim().startsWith('Plan'), 'picked Plan -> collapsed label "Plan"')
const storedRaw = await page.evaluate(() => localStorage.getItem('opencode.sessionAgents'))
let storedOk = false
try {
  const map = JSON.parse(storedRaw ?? '{}')
  const sid = Object.keys(map)[0]
  storedOk = Object.keys(map).length === 1 && map[sid] === 'plan' && !!sid
} catch {}
check(storedOk, `localStorage opencode.sessionAgents = ${storedRaw} (single per-session entry)`)

// 7. send -> payload carries top-level agent (+ model), slash branch untouched
const ta = pane.locator('#composer-input')
await ta.fill('hello agent picker')
await ta.press('Enter')
await page.waitForTimeout(600)
const body = promptBodies[promptBodies.length - 1]
check(!!body, 'prompt_async was intercepted')
check(body?.agent === 'plan', `payload agent = ${body?.agent}`)
check(!!body?.model?.providerID && !!body?.model?.modelID, `payload model present (${body?.model?.providerID}/${body?.model?.modelID})`)
check(body?.parts?.[0]?.text === 'hello agent picker', 'payload text intact')

// 8. back to Auto via the menu's Auto row
await pickerBtn.click()
await agentMenu.waitFor({ state: 'visible', timeout: 5000 })
const onRow = await agentMenu.locator('.m.on .nm').allTextContents()
check(onRow.map((s) => s.trim()).includes('Plan'), 'current selection marked in menu')
await agentMenu.locator('.m.auto').click()
await page.waitForTimeout(150)
check((await pickerBtn.textContent())?.trim().startsWith('Auto'), 'Auto row resets to default')
const afterAuto = await page.evaluate(() => localStorage.getItem('opencode.sessionAgents'))
check(afterAuto === '{}' || afterAuto === null, `session-agents map empty on Auto (got ${afterAuto})`)

// 9. sticky across reload
await pickerBtn.click()
await agentMenu.waitFor({ state: 'visible', timeout: 5000 })
await agentMenu.locator('.m', { hasText: 'Build' }).first().click()
await page.waitForTimeout(150)
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)
const lblAfter = await page.locator('.tabpane[style*="flex"] .toolbar .wrap:first-child .cur').textContent()
check(lblAfter?.trim().startsWith('Build'), `selection survives reload ("${lblAfter?.trim()}")`)

// 10. reset pref, mobile width pass
await page.evaluate(() => {
  localStorage.removeItem('opencode.agent')
  localStorage.removeItem('opencode.sessionAgents')
})
await page.setViewportSize({ width: 360, height: 740 })
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)
// the sidebar drawer stays open at this width and squeezes the pane — close it
const burger = page.locator('button.burger[title="Toggle sidebar"]')
if (await burger.isVisible().catch(() => false)) await burger.click()
await page.waitForTimeout(300)
const mpane = page.locator('.tabpane[style*="flex"]')
const mbtn = mpane.locator('.toolbar .wrap:first-child .cur')
const mtb = mpane.locator('#composer-input')
const b1 = await mbtn.boundingBox()
const t1 = await mtb.boundingBox()
check(b1 && t1 && b1.x + b1.width <= t1.x + 1, `picker left of textarea at 360px (btn right ${b1 && Math.round(b1.x + b1.width)}, ta left ${t1 && Math.round(t1.x)})`)
check(!!b1 && b1.width <= 90, `collapsed control compact at 360px (${b1 && Math.round(b1.width)}px wide)`)
await mbtn.click()
await mpane.locator('.wrap .menu').waitFor({ state: 'visible', timeout: 5000 })
const mobMenu = await mpane.locator('.wrap .menu').boundingBox()
check(mobMenu && mobMenu.x >= 0 && mobMenu.x + mobMenu.width <= 361, `mobile menu stays in viewport (${mobMenu && Math.round(mobMenu.width)}px wide)`)

// --- cleanup --------------------------------------------------------------
for (const sid of sessionIds) {
  await fetch(`${ENGINE}/session/${sid}`, { method: 'DELETE' }).catch(() => {})
  console.log('cleaned up probe session ' + sid)
}
await browser.close()
process.exit(summary())
