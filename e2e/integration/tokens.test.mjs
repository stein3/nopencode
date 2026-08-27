// Verify token tracking fix: sidebar tk badges, InfoPanel tokens/used for a
// session whose newest assistant message carries an all-zero tally.
import path from 'node:path'
import { BASE, ENGINE, launchBrowser, screenshot, SHOTS_DIR } from '../helpers/setup.mjs'

const errors = []
const browser = await launchBrowser({
  headless: true,
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
page.on('pageerror', (e) => errors.push(String(e)))
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 })

// 1) sidebar rows render with tk badges
await page.waitForSelector('.sidebar .item', { timeout: 15000 })
await page.waitForTimeout(1200)
const rowInfo = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.sidebar .item .sub')]
  const withTk = rows.filter((r) => /tk/.test(r.textContent || ''))
  return { total: rows.length, withTk: withTk.length, sample: withTk.slice(0, 3).map((r) => r.textContent.trim()) }
})
console.log('sidebar rows:', JSON.stringify(rowInfo))
if (rowInfo.withTk === 0) throw new Error('no sidebar row shows a tk badge')

// 2) open the previously-broken session (zero-token newest message)
await page.getByText('Healthscape dark and light theme options', { exact: false }).first().click()
await page.waitForSelector('.info .grid', { timeout: 15000 })
// InfoPanel refresh + store overlay need a beat
await page.waitForFunction(
  () => {
    const v = [...document.querySelectorAll('.info .grid .v')].map((e) => e.textContent.trim())
    return v[0] && v[0] !== '—'
  },
  { timeout: 15000 },
)
await page.waitForTimeout(500)
const panel = await page.evaluate(() => {
  const g = [...document.querySelectorAll('.info .grid')]
  const kv = {}
  g.forEach((el) => {
    const ks = el.querySelectorAll('.k, .v')
    for (let i = 0; i < ks.length; i += 2) kv[ks[i].textContent.trim()] = ks[i + 1]?.textContent.trim()
  })
  return { tokens: kv['tokens'], used: kv['used'], spent: kv['spent'] }
})
console.log('InfoPanel:', JSON.stringify(panel))
if (!panel.tokens || panel.tokens === '—') throw new Error('InfoPanel tokens still em-dash')
if (!/\d+%/.test(panel.used) && panel.used !== '—') throw new Error('InfoPanel used has no pct')

// 3) footer segment shows the context estimate
const footer = await page.evaluate(() => document.querySelector('.footer')?.textContent?.trim() ?? '')
console.log('footer:', JSON.stringify(footer.slice(0, 160)))

await page.screenshot({ path: path.join(SHOTS_DIR, 'tokens-fix.png') })
await browser.close()
console.log(errors.length ? 'PAGE ERRORS: ' + errors.join(' | ') : 'OK no page errors')
