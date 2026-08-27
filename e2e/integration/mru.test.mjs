import { BASE, launchBrowser, createChecker, screenshot, SHOTS_DIR } from '../helpers/setup.mjs'

const { check, summary } = createChecker()

const browser = await launchBrowser()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message))

await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)

// fresh state: clear recents + selected model
await page.evaluate(() => {
  localStorage.removeItem('opencode.modelRecents')
  localStorage.removeItem('opencode.model')
})
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)

// open the picker
const trigger = page.locator('.topbar .cur')
await trigger.click()
await page.waitForSelector('.menu .m')

// 1. flat list, no .prov headers, every row has nm+pv
const provHeaders = await page.locator('.menu .prov').count()
check(provHeaders === 0, 'no provider group headers (flat list)')
const rows = await page.locator('.menu .m').all()
check(rows.length > 3, `flat rows rendered (${rows.length})`)
for (const r of rows.slice(0, 5)) {
  const nm = await r.locator('.nm').textContent()
  const pv = await r.locator('.pv').textContent()
  check(!!nm?.trim() && !!pv?.trim(), `row has model name + provider tag: "${nm}" / "${pv}"`)
}

// 2. alphabetical when no recents
const names0 = []
for (const r of rows) names0.push(((await r.locator('.nm').textContent()) ?? '').trim())
const sorted0 = [...names0].sort((a, b) => a.localeCompare(b))
check(JSON.stringify(names0) === JSON.stringify(sorted0), 'initial order is alphabetical')

// 3. pick two models -> they float to top in reverse-pick order
// find two rows that are NOT currently selected; click by visible text
const pickNth = async (n) => {
  const btn = page.locator('.menu .m').nth(n)
  const nm = ((await btn.locator('.nm').textContent()) ?? '').trim()
  await btn.click()
  return nm
}
const firstPick = await pickNth(0)
await trigger.click() // reopen
await page.waitForSelector('.menu .m')
const secondPick = await pickNth(4) // pick something from mid-list
await trigger.click()
await page.waitForSelector('.menu .m')

let topTwo = []
for (const r of (await page.locator('.menu .m').all()).slice(0, 2)) {
  topTwo.push(((await r.locator('.nm').textContent()) ?? '').trim())
}
check(topTwo[0] === secondPick && topTwo[1] === firstPick, `MRU order after picks: [${topTwo}] == [${secondPick}, ${firstPick}]`)

// rest still alphabetical
const allNames = []
for (const r of await page.locator('.menu .m').all()) {
  allNames.push(((await r.locator('.nm').textContent()) ?? '').trim())
}
const tail = allNames.slice(2)
check(JSON.stringify(tail) === JSON.stringify([...tail].sort((a, b) => a.localeCompare(b))), 'tail remains alphabetical')

// 4. provider tag styling: smaller font + dim color vs model name
const firstRow = page.locator('.menu .m').first()
const styles = await firstRow.evaluate((el) => {
  const cs = getComputedStyle(el.querySelector('.nm'))
  const ps = getComputedStyle(el.querySelector('.pv'))
  return { nmSize: parseFloat(cs.fontSize), pvSize: parseFloat(ps.fontSize), nmColor: cs.color, pvColor: ps.color }
})
check(styles.pvSize < styles.nmSize, `provider tag smaller (${styles.pvSize}px < ${styles.nmSize}px)`)
const rgb = (c) => c.match(/\d+/g).slice(0, 3).map(Number)
const lum = (c) => rgb(c).reduce((a, b) => a + b, 0) / 3
check(lum(styles.pvColor) < lum(styles.nmColor), `provider tag darker/lighter (${styles.pvColor} vs ${styles.nmColor})`)

// 5. persistence across reload
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1200)
await trigger.click()
await page.waitForSelector('.menu .m')
let persisted = []
for (const r of (await page.locator('.menu .m').all()).slice(0, 2)) {
  persisted.push(((await r.locator('.nm').textContent()) ?? '').trim())
}
check(persisted[0] === secondPick && persisted[1] === firstPick, `order persists across reload: [${persisted}]`)

// screenshot of open menu
await screenshot(page, 'verify-mru')

await browser.close()
process.exit(summary())
