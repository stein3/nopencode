// Verify: Home/End transcript jump + input/hidden-pane guards, Alt+W close-tab
// fallback, Ctrl+W wiring, focus-mode toggle (webui hotkeys batch, 2026-08).
//
// Fixture: two probe sessions seeded via engine noReply user messages (no LLM
// turns), opened as tabs in the webui served by chatserver on :8123.
// Harness conventions: bench.mjs env setup + verify.mjs launch pattern;
// domcontentloaded (SSE never idles); panes scoped via .tabpane[style*="flex"].
import path from 'node:path'
import fs from 'node:fs'
import { BASE, ENGINE, E2E_DIR, launchBrowser, seedSession, cleanup, createChecker, screenshot, SHOTS_DIR } from '../helpers/setup.mjs'

const PANE = '.tabpane[style*="flex"]'
const CHATSERVER_PID = (() => {
  // started out-of-band before the run; pid captured in this file
  try {
    const m = fs.readFileSync(path.join(E2E_DIR, 'chatserver-hotkeys.pid'), 'utf8').match(/PID=(\d+)/)
    return m ? Number(m[1]) : null
  } catch {
    return null
  }
})()

const { check, summary } = createChecker()
const TITLE_A = 'Hotkey verify probe A ' + Date.now()
const TITLE_B = 'Hotkey verify probe B ' + Date.now()
let SID_A, SID_B

const pageErrors = []
const consoleErrors = []

// chatserver PID is killed in finally; browser closed before that
let browser
try {
  SID_A = await seedSession(TITLE_A, 12)
  SID_B = await seedSession(TITLE_B, 12)
  console.log(`seeded A=${SID_A} B=${SID_B}`)

  browser = await launchBrowser()
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } })
  page.on('pageerror', (e) => pageErrors.push(e.message))
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    const t = msg.text()
    if (/net::ERR|Failed to load resource|\/oc\/event/.test(t)) return // SSE/route noise
    consoleErrors.push(t)
  })

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 })
  await page.waitForSelector('.sidebar .item', { timeout: 15000 })

  // open both probes as tabs (tabs.open dedupes if boot auto-open already did)
  await page.click(`.sidebar .item[title="${TITLE_A}"]`)
  await page.waitForSelector(`${PANE} .msg`, { timeout: 15000 })
  await page.click(`.sidebar .item[title="${TITLE_B}"]`)
  await page.waitForFunction(
    (sid) => !!document.querySelector(`.tabbar .tab[data-sid="${sid}"]`) && !!document.querySelector('.tabpane[style*="flex"] .msg'),
    SID_B,
    { timeout: 15000 },
  )
  await page.waitForTimeout(600) // let activation pin + RO settle

  // pane i ↔ tab i (both iterate $tabs); scrollTop readable even under display:none
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

  // ---- 1. Home jumps to top and STAYS (stick-to-bottom must not re-pin) ----
  await page.click(`${PANE} .transcript`, { position: { x: 40, y: 200 } }) // body click, not an input
  await page.keyboard.press('Home')
  await page.waitForTimeout(300)
  const p1a = await activePane()
  await page.waitForTimeout(400)
  const p1b = await activePane()
  check(
    '1 Home jumps to top',
    p1a.st === 0 && p1b.st === 0,
    `scrollTop after 300ms=${p1a.st}, after 700ms=${p1b.st}`,
  )

  // ---- 2. End jumps to bottom and stays ------------------------------------
  await page.keyboard.press('End')
  await page.waitForTimeout(300)
  const p2a = await activePane()
  await page.waitForTimeout(400)
  const p2b = await activePane()
  const d2a = Math.abs(p2a.st - p2a.bottom)
  const d2b = Math.abs(p2b.st - p2b.bottom)
  check('2 End jumps to bottom', d2a <= 2 && d2b <= 2, `|st-bottom| 300ms=${d2a}, 700ms=${d2b}`)

  // ---- 3. Input guard: Home/End inside composer must not scroll ------------
  await page.locator('#composer-input:visible').click()
  const before3 = (await activePane()).st
  await page.keyboard.press('Home')
  await page.waitForTimeout(150)
  const afterHome3 = (await activePane()).st
  await page.keyboard.press('End')
  await page.waitForTimeout(150)
  const afterEnd3 = (await activePane()).st
  check(
    '3 input guard keeps transcript still',
    before3 === afterHome3 && afterHome3 === afterEnd3,
    `st ${before3} → Home ${afterHome3} → End ${afterEnd3}`,
  )

  // ---- 4. Hidden-pane guard: Home on active pane must not move hidden pane -
  await page.keyboard.press('Escape').catch(() => {}) // drop composer focus, best-effort
  await page.click(`${PANE} .transcript`, { position: { x: 40, y: 200 } })
  const aHiddenSt = (await paneOf(SID_A)).st // A is hidden while B active; readable regardless
  const bActiveSt = (await paneOf(SID_B)).st // B active & pinned at bottom (>0 when overflowing)
  if (!(bActiveSt > 0)) console.log('note: B not overflowing at guard test start — assertion would be vacuous')
  await page.click(`.tabbar .tab[data-sid="${SID_A}"]`) // switch back to probe A
  await page.waitForTimeout(400) // activation force-pin lands via rAF
  const aAfterSwitch = await paneOf(SID_A)
  const bAtSwitch = (await paneOf(SID_B)).st
  await page.keyboard.press('Home') // target = tab button/body, not an input
  await page.waitForTimeout(300)
  const aAfterHome = await paneOf(SID_A)
  const bAfterHome = (await paneOf(SID_B)).st
  await page.waitForTimeout(400)
  const aSettled = (await paneOf(SID_A)).st
  check(
    '4 active pane jumps Home after tab switch',
    aAfterHome.st === 0 && aSettled === 0,
    `A st: hidden=${aHiddenSt} → pinned@${aAfterSwitch.st} → Home ${aAfterHome.st} → settled ${aSettled}`,
  )
  // Chromium reads scrollTop as 0 for ANY display:none subtree (no boxes —
  // CSSOM View spec), so "unchanged" here compares 0→0; the non-vacuous
  // proof of no corruption is 4c: B must re-pin cleanly when reactivated.
  check(
    '4b hidden pane B scrollTop unchanged',
    bAfterHome === bAtSwitch,
    `B st ${bAtSwitch} → ${bAfterHome} (display:none reads 0 in Chromium${bActiveSt > 0 ? '' : ' — and B was not overflowing anyway'})`,
  )
  await page.click(`.tabbar .tab[data-sid="${SID_B}"]`) // back to B
  await page.waitForTimeout(500) // activation force-pin lands via rAF
  const bBack = await paneOf(SID_B)
  check(
    '4c reactivated hidden pane re-pins (no corruption)',
    Math.abs(bBack.st - bBack.bottom) <= 2,
    `B st=${bBack.st}, bottom=${bBack.bottom}`,
  )

  // ---- 5. Alt+W closes the active tab --------------------------------------
  await page.click(`.tabbar .tab[data-sid="${SID_A}"]`) // make A the active tab
  await page.waitForTimeout(300)
  const count5 = (await panes()).length
  await page.keyboard.press('Alt+w')
  await page.waitForTimeout(500)
  const list5 = await panes()
  check(
    '5 Alt+W closes tab',
    list5.length === count5 - 1 && !list5.some((p) => p.sid === SID_A),
    `tabs ${count5}→${list5.length}, A gone=${!list5.some((p) => p.sid === SID_A)}`,
  )

  // ---- 6. Ctrl+W wiring (headless has no chrome to eat the chord) ----------
  await page.click(`.sidebar .item[title="${TITLE_A}"]`)
  await page.waitForFunction((sid) => !!document.querySelector(`.tabbar .tab[data-sid="${sid}"]`), SID_A, {
    timeout: 10000,
  })
  await page.waitForTimeout(500)
  const count6 = (await panes()).length
  await page.keyboard.press('Control+w')
  await page.waitForTimeout(500)
  const list6 = await panes()
  check(
    '6 Ctrl+W closes tab',
    list6.length === count6 - 1 && !list6.some((p) => p.sid === SID_A),
    `tabs ${count6}→${list6.length}, A gone=${!list6.some((p) => p.sid === SID_A)}`,
  )

  // ---- 7. Focus-mode toggle -------------------------------------------------
  const btn = page.locator('[title^="Focus mode"]')
  check('7a focus-mode button exists', (await btn.count()) === 1)
  // swallow unhandledrejection so an unavailable-fullscreen rejection can't
  // surface as a pageerror — enableFocusMode's fallback chain may reject both
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
    await page.waitForTimeout(250)
    st7 = await page.evaluate(() => ({
      fs: !!document.fullscreenElement,
      pressed: !!document.querySelector('[title^="Focus mode"]')?.classList.contains('pressed'),
    }))
    if (st7.fs && st7.pressed) break
  }
  const unhandled7 = await page.evaluate(() => window.__unhandled || [])
  if (st7.fs && st7.pressed) {
    check('7 focus-mode ON (fullscreen + pressed)', true, 'path (a)')
    await btn.click() // restore
    let off = false
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(250)
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
      `path (b): fullscreen unavailable in headless — skipped; unhandled=${JSON.stringify(unhandled7)}`,
    )
  }

  // ---- 8. No page errors during the whole run ------------------------------
  check('8 no pageerror exceptions', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  if (consoleErrors.length) console.log('console errors (non-SSE):', JSON.stringify(consoleErrors.slice(0, 5)))

  await screenshot(page, 'hotkeys')
} catch (e) {
  console.log('FAIL harness-error —', e.message)
} finally {
  try {
    await browser?.close()
  } catch {}
  await cleanup([SID_A, SID_B])
  if (CHATSERVER_PID) {
    try {
      process.kill(CHATSERVER_PID)
      console.log(`cleanup chatserver pid ${CHATSERVER_PID} killed`)
    } catch (e) {
      console.log(`cleanup chatserver kill failed: ${e.message}`)
    }
  }
}

process.exit(summary())
