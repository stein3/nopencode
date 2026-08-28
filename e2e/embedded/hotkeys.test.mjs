// hotkeys.test.mjs — embedded fake-engine test for keyboard shortcuts:
// Home/End transcript scroll, input guard, hidden-pane guard, Alt+W close-tab,
// Ctrl+W close-tab, focus-mode toggle.
//
// Port 8154. Run: node e2e/embedded/hotkeys.test.mjs

import path from 'node:path'
import fs from 'node:fs'
import http from 'node:http'
import { DIST, launchBrowser, screenshot } from '../helpers/setup.mjs'

const PORT = 8154
const BASE = `http://127.0.0.1:${PORT}`

// ============================== fake engine =================================

const TITLE_A = 'Hotkey verify probe A ' + Date.now()
const TITLE_B = 'Hotkey verify probe B ' + Date.now()
const SID_A = 'ses_hk01'
const SID_B = 'ses_hk02'

function buildMessages(sid, title, count) {
  const msgs = []
  for (let i = 1; i <= count; i++) {
    msgs.push({
      info: {
        id: `msg_${sid}_${i}`,
        role: 'user',
        time: { created: Date.now() - 120_000 + i * 1000 },
      },
      parts: [
        { id: `part_${sid}_${i}`, type: 'text', text: `msg ${i} — ${title} — ` + 'filler line for scroll height. '.repeat(6) },
      ],
    })
  }
  return msgs
}

const MESSAGES = {
  [SID_A]: buildMessages(SID_A, TITLE_A, 12),
  [SID_B]: buildMessages(SID_B, TITLE_B, 12),
}

const sseClients = new Set()

function sseEmit(type, properties = {}) {
  const frame = `data: ${JSON.stringify({ type, properties })}\n\n`
  for (const res of sseClients) {
    try { res.write(frame) } catch { /* dropped */ }
  }
}

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
      return json(res, [
        { id: SID_A, title: TITLE_A, created: Date.now() - 120_000, updated: Date.now() - 30_000, message_count: 12, cost: 0 },
        { id: SID_B, title: TITLE_B, created: Date.now() - 60_000, updated: Date.now() - 10_000, message_count: 12, cost: 0 },
      ])
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
      const t = mSess[1] === SID_A ? TITLE_A : mSess[1] === SID_B ? TITLE_B : 'unknown'
      return json(res, { id: mSess[1], title: t, revert: null })
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

function check(name, pass, note = '') {
  results.push({ name, pass: !!pass, note })
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${note ? ` — ${note}` : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

    // open both probes as tabs
    await page.click(`.sidebar .item[title="${TITLE_A}"]`)
    await page.waitForSelector(`${PANE} .msg`, { timeout: 15000 })
    await page.click(`.sidebar .item[title="${TITLE_B}"]`)
    await page.waitForFunction(
      (sid) => !!document.querySelector(`.tabbar .tab[data-sid="${sid}"]`) && !!document.querySelector('.tabpane[style*="flex"] .msg'),
      SID_B,
      { timeout: 15000 },
    )
    await sleep(600)

    const panes = () =>
      page.evaluate(() => {
        const tabEls = [...document.querySelectorAll('.tabbar .tab')]
        const paneEls = [...document.querySelectorAll('.tabpane')]
        return tabEls.map((t, i) => {
          const tr = paneEls[i]?.querySelector('.transcript')
          return {
            sid: t.dataset.sid,
            display: paneEls[i]?.style.display || '',
            st: tr ? tr.scrollTop : null,
            bottom: tr ? tr.scrollHeight - tr.clientHeight : 0,
          }
        })
      })
    const activePane = async () => (await panes()).find((p) => p.display.includes('flex'))
    const paneOf = async (sid) => (await panes()).find((p) => p.sid === sid)

    // ---- 1. Home jumps to top and STAYS -------------------------------------
    console.log('\nCASE 1 — Home jumps to top')
    await page.click(`${PANE} .transcript`, { position: { x: 40, y: 200 } })
    await page.keyboard.press('Home')
    await sleep(300)
    const p1a = await activePane()
    await sleep(400)
    const p1b = await activePane()
    check(
      '1 Home jumps to top',
      p1a.st === 0 && p1b.st === 0,
      `scrollTop after 300ms=${p1a.st}, after 700ms=${p1b.st}`,
    )

    // ---- 2. End jumps to bottom and stays ------------------------------------
    console.log('\nCASE 2 — End jumps to bottom')
    await page.keyboard.press('End')
    await sleep(300)
    const p2a = await activePane()
    await sleep(400)
    const p2b = await activePane()
    const d2a = Math.abs(p2a.st - p2a.bottom)
    const d2b = Math.abs(p2b.st - p2b.bottom)
    check('2 End jumps to bottom', d2a <= 2 && d2b <= 2, `|st-bottom| 300ms=${d2a}, 700ms=${d2b}`)

    // ---- 3. Input guard: Home/End inside composer must not scroll ------------
    console.log('\nCASE 3 — input guard')
    await page.locator('#composer-input:visible').click()
    const before3 = (await activePane()).st
    await page.keyboard.press('Home')
    await sleep(150)
    const afterHome3 = (await activePane()).st
    await page.keyboard.press('End')
    await sleep(150)
    const afterEnd3 = (await activePane()).st
    check(
      '3 input guard keeps transcript still',
      before3 === afterHome3 && afterHome3 === afterEnd3,
      `st ${before3} → Home ${afterHome3} → End ${afterEnd3}`,
    )

    // ---- 4. Hidden-pane guard -----------------------------------------------
    console.log('\nCASE 4 — hidden-pane guard')
    await page.keyboard.press('Escape').catch(() => {})
    await page.click(`${PANE} .transcript`, { position: { x: 40, y: 200 } })
    const aHiddenSt = (await paneOf(SID_A)).st
    const bActiveSt = (await paneOf(SID_B)).st
    if (!(bActiveSt > 0)) console.log('note: B not overflowing at guard test start')
    await page.click(`.tabbar .tab[data-sid="${SID_A}"]`)
    await sleep(400)
    const aAfterSwitch = await paneOf(SID_A)
    const bAtSwitch = (await paneOf(SID_B)).st
    await page.keyboard.press('Home')
    await sleep(300)
    const aAfterHome = await paneOf(SID_A)
    const bAfterHome = (await paneOf(SID_B)).st
    await sleep(400)
    const aSettled = (await paneOf(SID_A)).st
    check(
      '4 active pane jumps Home after tab switch',
      aAfterHome.st === 0 && aSettled === 0,
      `A st: hidden=${aHiddenSt} → pinned@${aAfterSwitch.st} → Home ${aAfterHome.st} → settled ${aSettled}`,
    )
    check(
      '4b hidden pane B scrollTop unchanged',
      bAfterHome === bAtSwitch,
      `B st ${bAtSwitch} → ${bAfterHome}`,
    )
    await page.click(`.tabbar .tab[data-sid="${SID_B}"]`)
    await sleep(500)
    const bBack = await paneOf(SID_B)
    check(
      '4c reactivated hidden pane re-pins (no corruption)',
      Math.abs(bBack.st - bBack.bottom) <= 2,
      `B st=${bBack.st}, bottom=${bBack.bottom}`,
    )

    // ---- 5. Alt+W closes the active tab -------------------------------------
    console.log('\nCASE 5 — Alt+W closes tab')
    await page.click(`.tabbar .tab[data-sid="${SID_A}"]`)
    await sleep(300)
    const count5 = (await panes()).length
    await page.keyboard.press('Alt+w')
    await sleep(500)
    const list5 = await panes()
    check(
      '5 Alt+W closes tab',
      list5.length === count5 - 1 && !list5.some((p) => p.sid === SID_A),
      `tabs ${count5}→${list5.length}, A gone=${!list5.some((p) => p.sid === SID_A)}`,
    )

    // ---- 6. Ctrl+W wiring ---------------------------------------------------
    console.log('\nCASE 6 — Ctrl+W closes tab')
    await page.click(`.sidebar .item[title="${TITLE_A}"]`)
    await page.waitForFunction((sid) => !!document.querySelector(`.tabbar .tab[data-sid="${sid}"]`), SID_A, {
      timeout: 10000,
    })
    await sleep(500)
    const count6 = (await panes()).length
    await page.keyboard.press('Control+w')
    await sleep(500)
    const list6 = await panes()
    check(
      '6 Ctrl+W closes tab',
      list6.length === count6 - 1 && !list6.some((p) => p.sid === SID_A),
      `tabs ${count6}→${list6.length}, A gone=${!list6.some((p) => p.sid === SID_A)}`,
    )

    // ---- 7. Focus-mode toggle ------------------------------------------------
    console.log('\nCASE 7 — focus-mode toggle')
    const btn = page.locator('[title^="Focus mode"]')
    check('7a focus-mode button exists', (await btn.count()) === 1)
    await page.evaluate(() => {
      window.__unhandled = []
      window.addEventListener('unhandledrejection', (e) => {
        e.preventDefault()
        window.__unhandled.push(String((e.reason && e.reason.message) || e.reason))
      })
    })
    await btn.click()
    let st7 = { fs: false, pressed: false }
    for (let i = 0; i < 10; i++) {
      await sleep(250)
      st7 = await page.evaluate(() => ({
        fs: !!document.fullscreenElement,
        pressed: !!document.querySelector('[title^="Focus mode"]')?.classList.contains('pressed'),
      }))
      if (st7.fs && st7.pressed) break
    }
    const unhandled7 = await page.evaluate(() => window.__unhandled || [])
    if (st7.fs && st7.pressed) {
      check('7 focus-mode ON (fullscreen + pressed)', true)
      await btn.click()
      let off = false
      for (let i = 0; i < 10; i++) {
        await sleep(250)
        off = await page.evaluate(
          () => !document.fullscreenElement && !document.querySelector('[title^="Focus mode"]')?.classList.contains('pressed'),
        )
        if (off) break
      }
      check('7b focus-mode OFF restores', off)
    } else {
      check(
        '7 focus-mode graceful no-op',
        unhandled7.length === 0,
        `fullscreen unavailable in headless — unhandled=${JSON.stringify(unhandled7)}`,
      )
    }

    // ---- 8. No page errors --------------------------------------------------
    check('8 no pageerror exceptions', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
    if (consoleErrors.length) console.log('console errors (non-SSE):', JSON.stringify(consoleErrors.slice(0, 5)))

    await screenshot(page, 'hotkeys')
  } finally {
    await browser.close()
  }
} finally {
  await new Promise((r) => server.close(r))
}

// =============================== summary ====================================

console.log('\n================ SUMMARY ================')
const fails = results.filter((r) => !r.pass).length
console.log('Checks:', results.length, '| failed:', fails)
if (pageErrors.length) {
  console.log(`page errors (${pageErrors.length}):`)
  for (const e of [...new Set(pageErrors)].slice(0, 5)) console.log('  •', e.slice(0, 220))
}
process.exitCode = fails ? 1 : 0
