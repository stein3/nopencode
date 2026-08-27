// Verify: grep tool cards now render their output box with a "(n matches)"
// footer at the bottom, count taken from the engine's "Found N matches" header.
import { BASE, launchBrowser, SHOTS_DIR } from '../helpers/setup.mjs'

const SID = 'ses_fc677561effeskOs8gVV4dV04e' // session with completed grep parts
const TITLE = 'Grep match count in opencode output'

const browser = await launchBrowser()
// Tall viewport: the expanded outbox can exceed 1600px. A normal viewport
// forces beyond-viewport element capture, where content-visibility:auto skips
// painting the offscreen part of the .msg row (blank lower half, missing
// footer) and the sticky composer composites over the element rect. On-screen
// capture avoids both artifacts.
const page = await browser.newPage({ viewport: { width: 1280, height: 1900 } })
// Freeze ALL live churn during capture: SSE events AND busy-flip refetches
// (Footer refetch → tabs.patch → Transcript re-render resets <details> open
// state between bbox measure and raster). Initial loads must pass through,
// so these routes only start aborting once the fixture tab has rendered.
let frozen = false
const FREEZE_RE = /\/oc\/event|\/oc\/session\/status|\/session\/[^/]+\/message/
await page.route(FREEZE_RE, (route) =>
  frozen ? route.abort() : route.fallback()
)
await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.sidebar .item', { timeout: 15000 })
// open the fixture session via its sidebar row (title attr holds the session title)
const row = page.locator(`.sidebar .item[title="${TITLE}"]`)
if (!(await row.count())) throw new Error('fixture session not found in sidebar')
await row.click()
// inactive tab panes stay mounted under display:none — scope to the VISIBLE one
const PANE = '.tabpane[style*="flex"]'
try {
  await page.waitForSelector(`${PANE} .toolcard`, { timeout: 8000 })
} catch {
  // pane didn't activate — click the session's tab in the tab bar
  const tb = page.locator(`.tabbar .tab[title="${TITLE}"]`)
  if (!(await tb.count())) throw new Error('fixture tab not found in tab bar')
  await tb.click()
}
await page.waitForSelector(`${PANE} .toolcard`, { timeout: 15000 })

// find a grep tool card (summary text contains the pattern detail; class tc-search)
const cards = page.locator(`${PANE} .toolcard`)
// freeze live churn only once the FIXTURE session's own content is rendered —
// freezing earlier can abort its windowed message loads mid-flight
await page.waitForSelector(`${PANE} .toolcard summary .tname:text-matches("grep", "i")`, { timeout: 15000 })
frozen = true
const n = await cards.count()
let grepIdx = -1
for (let i = 0; i < n; i++) {
  const t = (await cards.nth(i).locator('summary .tname').textContent()) ?? ''
  if (/grep/i.test(t)) { grepIdx = i; break }
}
if (grepIdx < 0) throw new Error('no grep tool card found in session')

const card = cards.nth(grepIdx)
// errored greps legitimately have no output box; find one that does
let outbox = null
for (let i = grepIdx; i < n; i++) {
  const t = (await cards.nth(i).locator('summary .tname').textContent()) ?? ''
  if (!/grep/i.test(t)) continue
  const ob = cards.nth(i).locator('details.outbox').first()
  if (await ob.count()) { outbox = ob; break }
}
if (!outbox) throw new Error('no completed grep tool card with output box found')
await outbox.scrollIntoViewIfNeeded()
await outbox.locator('summary').click() // expand
await page.waitForTimeout(200)

const outText = (await outbox.locator('pre.out').textContent()) ?? ''
const footer = outbox.locator('.matchcount')
if (!(await footer.count())) throw new Error('missing .matchcount footer')
const footText = ((await footer.textContent()) ?? '').trim()

const header = outText.match(/^Found (\d+) matches/)
if (!header) throw new Error('fixture output lacks Found N matches header')
const expect = `(${header[1]} ${Number(header[1]) === 1 ? 'match' : 'matches'})`
if (footText !== expect) throw new Error(`footer "${footText}" != expected "${expect}"`)

console.log(`OK: grep outbox renders, footer "${footText}" matches header count ${header[1]}`)
// Clear the transcript's stick-to-bottom pin with REAL wheel-up input —
// programmatic scrollIntoView never clears `stuck`, so follow() re-pins the
// pane to bottom right after any manual scroll (documented webui behavior).
const paneBox = await page.locator(PANE).boundingBox()
await page.mouse.move(paneBox.x + paneBox.width / 2, paneBox.y + paneBox.height / 2)
await page.mouse.wheel(0, -800)
await page.waitForTimeout(100)
// box may be taller than the pane — align its TOP; playwright captures the
// full element rect beyond the viewport via CDP
await outbox.evaluate((el) => el.scrollIntoView({ block: 'start' }))
if ((await outbox.getAttribute('open')) === null) await outbox.locator('summary').click()
const bbox = await outbox.boundingBox()
console.log('outbox bbox:', JSON.stringify(bbox))
if (!bbox || bbox.height < 40 || bbox.y < paneBox.y - 5 || bbox.y > paneBox.y + 60)
  throw new Error(`outbox top not aligned in-pane before capture: ${JSON.stringify(bbox)}`)
// whole box must sit above the sticky composer to avoid overlay compositing
// (scope to the visible pane — every mounted tab pane has its own composer)
const compBox = await page.locator(`${PANE} #composer-input`).boundingBox()
if (compBox && bbox.y + bbox.height > compBox.y - 8)
  throw new Error(`outbox bottom (${bbox.y + bbox.height}) reaches composer top (${compBox.y}) — raise viewport height`)
if ((await outbox.getAttribute('open')) === null) throw new Error('outbox collapsed before capture')
await page.waitForTimeout(100)
const bbox2 = await outbox.boundingBox()
if (Math.abs((bbox2?.y ?? -1) - bbox.y) > 2) throw new Error('layout still moving before capture')
await outbox.screenshot({ path: `${SHOTS_DIR}/grep-matchcount-${Date.now()}.png` })
await page.screenshot({ path: `${SHOTS_DIR}/grep-matchcount-full.png` }) // backup context
await browser.close()
