// navkeys.test.mjs — embedded fake-engine test for keyboard shortcuts around
// session-list nav (Alt+Up/Down) and tab cycling (Alt+Left/Right):
//   1. Alt+Down steps exactly one row per press (regression: double-dispatch
//      via hotkeys.ts + Sidebar onNavKey jumped two rows per press)
//   2. Alt+Up symmetric + wrap at the ends
//   3. plain ArrowUp/Down continue the nav (onNavKey path)
//   4. Enter opens the focused row, Escape clears nav focus
//   5. nav from inside the composer blurs it, input preserved
//   6. modifier combos (Ctrl+Arrow) do zero nav steps
//   7. 3s auto-unlock drops nav focus
//   8. Alt+Left/Right cycle tabs exactly one step per press
//
// First Alt+press anchors at the active session (f3aea50 semantics), then
// every press moves exactly one visible row. Per-press focused-row assertions
// — a single end-state check would miss ±1 drift.
//
// Port 8214. Run: node e2e/embedded/navkeys.test.mjs

import path from 'node:path'
import fs from 'node:fs'
import http from 'node:http'
import { DIST, launchBrowser, screenshot, sleep } from '../helpers/setup.mjs'

const PORT = Number(process.env.PORT) || 8214
const BASE = `http://127.0.0.1:${PORT}`

// ============================== fake engine =================================

// display order is `updated`-desc (Sidebar re-sorts), so A is the top row
const SPECS = [
  { id: 'ses_nk01', key: 'A', up: 10_000 },
  { id: 'ses_nk02', key: 'B', up: 20_000 },
  { id: 'ses_nk03', key: 'C', up: 30_000 },
  { id: 'ses_nk04', key: 'D', up: 40_000 },
]
const TITLE = Object.fromEntries(SPECS.map((s) => [s.key, `Nav probe ${s.key} ${Date.now()}`]))
const T = Object.fromEntries(SPECS.map((s) => [s.id, TITLE[s.key]]))

function buildMessages(sid) {
  return [1, 2].map((i) => ({
    info: {
      id: `msg_${sid}_${i}`,
      role: 'user',
      time: { created: Date.now() - 120_000 + i * 1000 },
    },
    parts: [
      { id: `part_${sid}_${i}`, type: 'text', text: `msg ${i} — ${T[sid]} — filler line. `.repeat(6) },
    ],
  }))
}
const MESSAGES = Object.fromEntries(SPECS.map((s) => [s.id, buildMessages(s.id)]))

const sseClients = new Set()

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.ttf': 'font/ttf',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json', '.txt': 'text/plain',
}

function json(res, obj, code = 200) {
  const b = Buffer.from(JSON.stringify(obj))
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length })
  res.end(b)
}

const server = http.createServer(async (req, res) => {
  const p = (req.path_url ??= req.url.split('?')[0])

  try {
    if (p === '/__state') return json(res, {})
    if (p === '/__ctl') return json(res, { ok: true })

    // ---- SSE -----------------------------------------------------------------
    if (p === '/oc/event') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      sseClients.add(res)
      req.on('close', () => sseClients.delete(res))
      return
    }

    // ---- history --------------------------------------------------------------
    if (p === '/api/history/sessions') {
      return json(res, SPECS.map((s) => ({
        id: s.id, title: T[s.id],
        created: Date.now() - 120_000, updated: Date.now() - s.up,
        message_count: 2, cost: 0,
      })))
    }
    if (p.startsWith('/api/history/session/')) return json(res, [])
    if (p.endsWith('/errors')) {
      if (req.method === 'GET') return json(res, [])
      return json(res, { ok: true })
    }

    // ---- engine ---------------------------------------------------------------
    if (p === '/oc/session/status') return json(res, {})
    const mMsg = p.match(/^\/oc\/session\/([^/]+)\/message$/)
    if (mMsg && req.method === 'GET') return json(res, MESSAGES[mMsg[1]] ?? [])
    const mSess = p.match(/^\/oc\/session\/([^/]+)$/)
    if (mSess && req.method === 'GET') {
      return json(res, { id: mSess[1], title: T[mSess[1]] ?? 'unknown', revert: null })
    }
    if (p === '/oc/session' && req.method === 'POST') return json(res, { id: 'ses_new', title: 'new', revert: null })
    if (p === '/oc/session' && req.method === 'DELETE') return json(res, { ok: true })
    if (p === '/oc/config/providers') return json(res, {
      providers: [{ id: 'opencode', models: { 'x-preview-f-free': { id: 'x-preview-f-free' } } }],
    })
    if (p === '/oc/path') return json(res, { directory: '/workspace' })
    if (p === '/oc/mcp') return json(res, {})
    if (p.startsWith('/oc/')) return json(res, [])

    // ---- statics (webui/dist) -------------------------------------------------
    const rel = p === '/' ? '/index.html' : p
    const full = fs.realpathSync(path.join(DIST, rel))
    if (!full.startsWith(fs.realpathSync(DIST)) || !fs.statSync(full).isFile())
      return json(res, { error: 'missing' }, 404)
    const ct = MIME[path.extname(full)] ?? 'application/octet-stream'
    const b = fs.readFileSync(full)
    res.writeHead(200, { 'Content-Type': ct, 'Content-Length': b.length, 'Cache-Control': 'no-store' })
    res.end(b)
  } catch (e) {
    try { json(res, { error: String(e) }, 500) } catch { /* headers sent */ }
  }
})

// ================================ checks ====================================

const results = []
let pageErrors = []
let consoleErrors = []

function check(c, name, pass, note = '') {
  results.push({ c, name, pass: !!pass, note })
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${c} · ${name}${note ? ` — ${note}` : ''}`)
}

const PANE = '.tabpane[style*="flex"]'

// ================================ run =======================================

try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

  const browser = await launchBrowser()
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } })
  page.on('pageerror', (e) => pageErrors.push(e.message))
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    const t = msg.text()
    if (/net::ERR|Failed to load resource|\/oc\/event/.test(t)) return
    consoleErrors.push(t)
  })

  try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 })
    await page.waitForSelector('.sidebar .item', { timeout: 15000 })

    const rows = await page.evaluate(() =>
      [...document.querySelectorAll('.sidebar .item')].map((el) => el.getAttribute('title')),
    )
    check('0', 'sidebar shows 4 rows in updated-desc order',
      JSON.stringify(rows) === JSON.stringify([TITLE.A, TITLE.B, TITLE.C, TITLE.D]),
      `rows=${JSON.stringify(rows)}`)

    // open B as the active anchor session
    await page.click(`.sidebar .item[title="${TITLE.B}"]`)
    await page.waitForSelector(`${PANE} .msg`, { timeout: 15000 })
    await sleep(300)

    const focusedTitle = () =>
      page.evaluate(() => document.querySelector('.sidebar .item.nav-focused')?.getAttribute('title') ?? null)

    // one press → one assertion on the focused row (the only check that would
    // have caught the double-dispatch bug). `at` tracks the focused row index
    // in display order; each nav press must move it exactly ±1 (with wrap).
    const n = rows.length
    let at = -1
    const rowAt = (i) => rows[((i % n) + n) % n]
    async function pressNav(c, name, key, dir, anchor = false) {
      await page.keyboard.press(key)
      await sleep(150)
      const got = await focusedTitle()
      at = anchor ? rows.indexOf(TITLE.B) : at + dir
      check(c, name, got === rowAt(at), `expected=${rowAt(at)} got=${got}`)
    }
    async function pressSame(c, name, key) {
      await page.keyboard.press(key)
      await sleep(150)
      const got = await focusedTitle()
      check(c, name, got === rowAt(at), `expected=${rowAt(at)} got=${got}`)
    }

    // ---- 1. Alt+Down: anchor, then exactly one row per press ------------------
    console.log('\nCASE 1 — Alt+Down steps one row per press')
    await page.locator('#composer-input:visible').click()
    await pressNav('1a', 'first press anchors at active session', 'Alt+ArrowDown', 0, true)
    await pressNav('1b', 'second press steps exactly one row', 'Alt+ArrowDown', 1)
    await pressNav('1c', 'third press steps exactly one row', 'Alt+ArrowDown', 1)

    // ---- 2. Alt+Up symmetric + wrap ------------------------------------------
    console.log('\nCASE 2 — Alt+Up steps one row per press + wraps')
    await pressNav('2a', 'Alt+Up steps back one row', 'Alt+ArrowUp', -1)
    await pressNav('2b', 'Alt+Up steps back one row', 'Alt+ArrowUp', -1)
    await pressNav('2c', 'Alt+Up steps back one row', 'Alt+ArrowUp', -1)
    await pressNav('2d', 'Alt+Up wraps to the bottom row', 'Alt+ArrowUp', -1)

    // ---- 3. plain arrows continue the nav ------------------------------------
    console.log('\nCASE 3 — plain ArrowUp/Down continue nav')
    await page.keyboard.press('Escape')
    await sleep(150)
    check('3a', 'Escape clears nav focus', (await focusedTitle()) === null)
    await pressNav('3b', 'Alt+Down re-anchors at active session', 'Alt+ArrowDown', 0, true)
    await pressNav('3c', 'plain ArrowDown steps one row', 'ArrowDown', 1)
    await pressNav('3d', 'plain ArrowDown steps one row', 'ArrowDown', 1)

    // ---- 6. modifier combos do zero nav steps (guard regression) -------------
    console.log('\nCASE 6 — modifier guard')
    await pressSame('6a', 'Control+ArrowDown does not move nav', 'Control+ArrowDown')
    await pressSame('6b', 'Control+ArrowUp does not move nav', 'Control+ArrowUp')

    // ---- 5. nav from inside the composer -------------------------------------
    console.log('\nCASE 5 — nav from composer blurs it, input preserved')
    await page.keyboard.press('Escape')
    await sleep(150)
    await page.locator('#composer-input:visible').click()
    await page.keyboard.type('hello')
    await pressNav('5a', 'Alt+Down anchors from composer', 'Alt+ArrowDown', 0, true)
    await pressNav('5b', 'Alt+Down steps one row', 'Alt+ArrowDown', 1)
    const c5 = await page.evaluate(() => {
      const ta = [...document.querySelectorAll('#composer-input')].find((el) => el.offsetParent !== null)
      return {
        val: ta?.value ?? null,
        typing: document.activeElement === ta,
      }
    })
    check('5c', 'composer blurred, draft preserved',
      c5.val === 'hello' && !c5.typing,
      `val=${JSON.stringify(c5.val)} still-focused=${c5.typing}`)

    // ---- 7. 3s auto-unlock ----------------------------------------------------
    console.log('\nCASE 7 — auto-unlock after 3s idle')
    await page.keyboard.press('Escape')
    await sleep(150)
    await pressNav('7a', 'Alt+Down anchors', 'Alt+ArrowDown', 0, true)
    await sleep(3300)
    check('7b', 'nav focus cleared after 3s idle', (await focusedTitle()) === null)
    await page.keyboard.press('ArrowDown')
    await sleep(150)
    check('7c', 'plain ArrowDown does nothing after unlock', (await focusedTitle()) === null)

    // ---- 4. Enter opens, Escape clears ---------------------------------------
    console.log('\nCASE 4 — Enter opens focused row')
    await pressNav('4a', 'Alt+Down anchors', 'Alt+ArrowDown', 0, true)
    await pressNav('4b', 'ArrowDown steps', 'ArrowDown', 1)
    const wantOpen = rowAt(at)
    await page.keyboard.press('Enter')
    await sleep(400)
    const c4 = await page.evaluate(() => ({
      cur: document.querySelector('.sidebar .item.current')?.getAttribute('title') ?? null,
      nav: document.querySelector('.sidebar .item.nav-focused')?.getAttribute('title') ?? null,
    }))
    check('4c', 'Enter opens the focused session, clears nav',
      c4.cur === wantOpen && c4.nav === null,
      `current=${c4.cur} want=${wantOpen} nav-leftover=${c4.nav}`)

    // ---- 8. Alt+Left/Right tab cycling ---------------------------------------
    console.log('\nCASE 8 — Alt+Left/Right cycle tabs one step')
    await page.click(`.sidebar .item[title="${TITLE.D}"]`)
    await sleep(400)
    const tabState = () =>
      page.evaluate(() => {
        const tabs = [...document.querySelectorAll('.tabbar .tab')]
        return {
          ids: tabs.map((t) => t.dataset.sid),
          cur: tabs.findIndex((t) => t.classList.contains('active')),
        }
      })
    const s8 = await tabState()
    check('8a', 'at least 3 tabs open', s8.ids.length >= 3, `tabs=${s8.ids.length} active=${s8.cur}`)
    // each press must move the active tab exactly one index (with wrap)
    async function pressTab(c, name, key, dir) {
      await page.keyboard.press(key)
      await sleep(250)
      const st = await tabState()
      const want = ((s8.cur + dir) % st.ids.length + st.ids.length) % st.ids.length
      check(c, name, st.cur === want, `active ${s8.cur}→${st.cur} (want ${want})`)
      s8.cur = st.cur
    }
    await pressTab('8b', 'Alt+Right activates the next tab', 'Alt+ArrowRight', 1)
    await pressTab('8c', 'Alt+Left activates the previous tab', 'Alt+ArrowLeft', -1)
    await pressTab('8d', 'Alt+Left wraps backwards one step', 'Alt+ArrowLeft', -1)

    // ---- 9. No page errors ----------------------------------------------------
    check('9', 'no pageerror exceptions', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
    if (consoleErrors.length) console.log('console errors (non-SSE):', JSON.stringify(consoleErrors.slice(0, 5)))

    await screenshot(page, 'navkeys')
  } finally {
    await browser.close()
  }
} finally {
  await new Promise((r) => server.close(r))
}

// =============================== summary ====================================

console.log('\n================ SUMMARY ================')
let fails = 0
for (const r of results) {
  const tag = r.pass ? 'PASS' : 'FAIL'
  console.log(`  [${tag}] ${r.name}${r.note ? ` — ${r.note}` : ''}`)
  if (!r.pass) fails++
}
if (pageErrors.length) {
  console.log(`\npage errors observed (${pageErrors.length}):`)
  for (const e of [...new Set(pageErrors)].slice(0, 5)) console.log('  •', e.slice(0, 220))
}
console.log('\nChecks:', results.length, '| failed:', fails)
process.exitCode = fails ? 1 : 0
