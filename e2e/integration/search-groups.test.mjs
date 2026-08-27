// Verify grouped search results in sidebar (grouped by session, desc by latest match, relTime hint)
import path from 'node:path'
import { BASE, launchBrowser, SHOTS_DIR } from '../helpers/setup.mjs'

const Q = 'opencode'

// mirror of webui/src/lib/util.ts relTime for cross-checking rendered hints
function relTime(ts) {
  if (!ts) return ''
  const ms = ts < 1e12 ? ts * 1000 : ts
  const d = Date.now() - ms
  const min = Math.floor(d / 60000)
  if (min < 1) return 'now'
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h`
  const days = Math.floor(h / 24)
  if (days < 30) return `${days}d`
  return new Date(ms).toLocaleDateString()
}

const api = await fetch(`${BASE}/api/search?q=${encodeURIComponent(Q)}`).then((r) => r.json())
const latest = new Map()
const titleOf = new Map()
for (const h of api) {
  titleOf.set(h.session_id, h.session_title)
  if (!latest.has(h.session_id) || h.time > latest.get(h.session_id)) latest.set(h.session_id, h.time)
}
const expected = [...latest.entries()]
  .sort((a, b) => b[1] - a[1])
  .map(([sid, t]) => `${titleOf.get(sid)}|${relTime(t)}`)

const browser = await launchBrowser()
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 })
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#sidebar-search', { timeout: 15000 })
  await page.fill('#sidebar-search', Q)
  await page.waitForSelector('.grphead', { timeout: 10000 })
  await page.waitForTimeout(500)

  const ui = await page.evaluate(() => {
    const heads = [...document.querySelectorAll('.grphead')].map((el) => ({
      title: el.querySelector('.title')?.textContent.trim() ?? '',
      meta: el.querySelector('.meta')?.textContent.trim() ?? '',
    }))
    const hits = [...document.querySelectorAll('.item.hit')]
    return {
      section: document.querySelector('.section')?.textContent.trim() ?? '',
      heads,
      hitCount: hits.length,
      hitPad: hits[0] ? getComputedStyle(hits[0]).paddingLeft : null,
      headPad: getComputedStyle(document.querySelector('.grphead')).paddingLeft,
    }
  })

  const got = ui.heads.map((h) => `${h.title}|${h.meta}`)
  const fails = []
  const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) fails.push(name) }

  check('section header', /Results \(\d+ in \d+ chats\)/.test(ui.section), ui.section)
  check('group count matches API', ui.heads.length === expected.length, `ui=${ui.heads.length} api=${expected.length}`)
  check('hit count matches API', ui.hitCount === api.length, `ui=${ui.hitCount} api=${api.length}`)
  check('groups ordered desc-by-latest + hints', JSON.stringify(got) === JSON.stringify(expected),
    got.slice(0, 4).join(' ; ') || '(empty)')
  check('hints non-empty', ui.heads.every((h) => h.meta.length > 0), ui.heads.map((h) => h.meta).join(','))
  check('hits indented under headers', parseInt(ui.hitPad) > parseInt(ui.headPad), `hit=${ui.hitPad} head=${ui.headPad}`)

  // term highlighting: .hl spans present, no sentinel chars leaked, hl text matches query
  const hl = await page.evaluate((q) => {
    const spans = [...document.querySelectorAll('.snippet .hl')]
    const allSnip = [...document.querySelectorAll('.snippet')].map((s) => s.textContent)
    return {
      count: spans.length,
      leaked: allSnip.some((t) => t.includes('\x00') || t.includes('\x01')),
      sample: spans.slice(0, 3).map((s) => s.textContent),
      allMatch: spans.every((s) => s.textContent.toLowerCase().includes(q)),
      bg: spans[0] ? getComputedStyle(spans[0]).backgroundColor : null,
    }
  }, Q)
  check('highlight spans rendered', hl.count > 0, `count=${hl.count} sample=${JSON.stringify(hl.sample)}`)
  check('no sentinel chars in DOM', !hl.leaked)
  check('highlighted text contains query', hl.allMatch)
  check('highlight bg applied', hl.bg && hl.bg !== 'rgba(0, 0, 0, 0)', hl.bg)

  // click-through still opens the session (poll; log pane diagnostics on failure)
  const panesBefore = await page.locator('.tabpane').count()
  await page.locator('.item.hit').first().click()
  let paneVisible = false
  try {
    await page.waitForSelector('.tabpane:visible', { timeout: 6000 })
    paneVisible = true
  } catch {
    const diag = await page.evaluate(() =>
      [...document.querySelectorAll('.tabpane')].map((p) => ({
        style: p.getAttribute('style')?.slice(0, 60),
        msgs: p.querySelectorAll('.msg').length,
      })),
    )
    console.log('PANE DIAG:', JSON.stringify(diag))
  }
  check('click-through opens transcript', paneVisible, `panesBefore=${panesBefore}`)

  // screenshot sidebar for visual confirmation
  await page.evaluate(() => document.querySelector('#sidebar-search').blur())
  await page.fill('#sidebar-search', Q)
  await page.waitForTimeout(400)
  await page.locator('aside.sidebar').screenshot({ path: path.join(SHOTS_DIR, 'search-groups.png') })
  console.log(fails.length ? `RESULT: ${fails.length} FAILURE(S)` : 'RESULT: ALL PASS')
} finally {
  await browser.close()
}
process.exit(fails.length ? 1 : 0)
