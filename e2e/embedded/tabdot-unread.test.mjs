// tabdot-unread.test.mjs — the tab-bar activity dot is a SESSION state, never a
// fetch state.
//
// The bug (measured in a prior session, then "fixed" only for catchUp): the
// green tab dot rendered `tab.dirty && !tab.busy`. `stores.ts` documents
// `dirty` as "refetch pending", so the dot painted the in-flight window of a
// background GET /message — ~353ms of green on a tab whose turn had just ended
// while you were looking at another tab. Every non-quiet `refetchNow()` caller
// (revert, fork, engine commands) and every `scheduleRefetch()` (any SSE event
// on an open idle tab) set it; passing `quiet: true` in catchUp killed ONE
// source only.
//
// The fix: Tabs.svelte paints `sessionUnread` instead — marked by sse.ts when a
// turn ENDS (session.idle / session.error / engine retry) on a tab that is not
// active, cleared by App.svelte on activation, and already the sidebar row's
// green light. `dirty` stays exactly where it belongs: internal fetch
// bookkeeping that nothing renders.
//
// Cases:
//   T1 a background refetch (and a bare idle) costs the dot NOTHING (the flash)
//   T2 a turn ending on a background tab lights it green (the real signal)
//   T3 opening that tab clears it
//   T4 the same holds for the other direction (symmetry, not a one-tab hack)
//   T5 the ACTIVE tab's turn ending never lights it (you are looking at it)
//
// Self-contained: serves webui/dist with a fake engine + scripted SSE, like
// linked-sessions.test.mjs. Run: node e2e/embedded/tabdot-unread.test.mjs

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { DIST, launchBrowser, sleep, poll } from '../helpers/setup.mjs'

const PORT = Number(process.env.PORT || 8191)
const BASE = `http://127.0.0.1:${PORT}`

const A = 'ses_tabdot_a' // the background tab
const B = 'ses_tabdot_b' // the tab under the cursor

const NOW = Date.now()
const SESSIONS = [
  { id: A, title: 'alpha background', created: NOW - 900_000, updated: NOW - 60_000, message_count: 2, cost: 0 },
  { id: B, title: 'beta foreground', created: NOW - 800_000, updated: NOW - 30_000, message_count: 2, cost: 0 },
]
const messagesFor = (sid) => [
  {
    info: { id: `msg_${sid}_u`, role: 'user', time: { created: NOW - 120_000 } },
    parts: [{ id: `part_${sid}_u`, type: 'text', text: `prompt for ${sid}` }],
  },
  {
    info: {
      id: `msg_${sid}_a`,
      role: 'assistant',
      agent: 'build',
      modelID: 'x-preview-f-free',
      providerID: 'opencode',
      time: { created: NOW - 110_000, completed: NOW - 109_000 },
    },
    parts: [{ id: `part_${sid}_a`, type: 'text', text: `reply from ${sid}` }],
  },
]

// ---------------------------------------------------------------- fake server

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
}
const json = (res, obj, code = 200) => {
  const b = Buffer.from(JSON.stringify(obj))
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length })
  res.end(b)
}

const sseClients = new Set()
const sseEmit = (type, properties = {}) => {
  const frame = `data: ${JSON.stringify({ type, properties })}\n\n`
  for (const res of sseClients) {
    try {
      res.write(frame)
    } catch {
      /* dropped connection */
    }
  }
}
const state = { msgFetches: {} } // sid -> count of GET /oc/session/{sid}/message

const server = http.createServer((req, res) => {
  const p = req.url.split('?')[0]
  try {
    if (p === '/__ctl/emit') {
      // scripted SSE, driven from the test process
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const { type, properties } = JSON.parse(body || '{}')
        sseEmit(type, properties)
        json(res, { ok: true, clients: sseClients.size })
      })
      return
    }
    if (p === '/__state') return json(res, state)

    if (p === '/oc/event') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      sseClients.add(res)
      req.on('close', () => sseClients.delete(res))
      return
    }

    if (p === '/api/history/sessions') return json(res, SESSIONS)
    if (p.startsWith('/api/history/session/')) return json(res, [])
    const mMsg = p.match(/^\/oc\/session\/([^/]+)\/message$/)
    if (mMsg) {
      state.msgFetches[mMsg[1]] = (state.msgFetches[mMsg[1]] ?? 0) + 1
      return json(res, messagesFor(mMsg[1]))
    }
    const mSes = p.match(/^\/oc\/session\/([^/]+)$/)
    if (mSes) return json(res, { id: mSes[1], title: mSes[1] === A ? 'alpha background' : 'beta foreground', revert: null })
    if (p === '/oc/session') return json(res, SESSIONS)
    if (p === '/oc/session/status') return json(res, {})
    if (p === '/oc/permission' || p === '/oc/question' || p === '/oc/agent' || p === '/oc/command' || p === '/oc/skill')
      return json(res, [])
    if (p === '/oc/config/providers')
      return json(res, { providers: [{ id: 'opencode', models: { 'x-preview-f-free': { id: 'x-preview-f-free' } } }] })
    if (p === '/oc/path') return json(res, { directory: '/workspace' })
    if (p === '/oc/mcp') return json(res, {})
    if (p.startsWith('/oc/') || p.startsWith('/api/')) return json(res, {})

    const rel = p === '/' ? '/index.html' : p
    const full = fs.realpathSync(path.join(DIST, rel))
    if (!full.startsWith(fs.realpathSync(DIST)) || !fs.statSync(full).isFile()) return json(res, { error: 'missing' }, 404)
    const b = fs.readFileSync(full)
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] ?? 'application/octet-stream',
      'Content-Length': b.length,
      'Cache-Control': 'no-store',
    })
    res.end(b)
  } catch (e) {
    try {
      json(res, { error: String(e?.message ?? e) }, 404)
    } catch {
      /* already answered */
    }
  }
})
const emit = (type, properties) =>
  fetch(`${BASE}/__ctl/emit`, { method: 'POST', body: JSON.stringify({ type, properties }) }).then((r) => r.json())

/**
 * End a REAL turn on `sid`. sse.ts marks a background tab unread only when an
 * idle follows a turn this client believed was running — `session.idle` is a
 * STATE frame, and an idle that changes nothing carries no news. `session.status
 * {type:'busy'}` is the frame that says "the engine went busy without us
 * asking", which is the foreign-turn case the light exists for.
 */
async function turn(sid) {
  await emit('session.status', { sessionID: sid, status: { type: 'busy' } })
  await sleep(400)
  await emit('session.idle', { sessionID: sid })
}

// ------------------------------------------------------------------- sampling

/**
 * Watch one tab's dot for `ms` and count the frames in which it is painted a
 * colour, BY CLASS. The dot's base state is `background: transparent`, so a
 * non-transparent computed colour means a status class was on — which is exactly
 * what the bug produced for ~353ms, far too short for sleep()-and-read to catch
 * reliably. Class names (not colours) are the contract: `busy` is amber and
 * legitimate during a turn, `unread` (and the retired `dirty`) are green.
 * Returns { frames, lit, byClass }.
 */
function watchDotFor(page, sid, ms) {
  return page.evaluate(
    ({ sid, ms }) =>
      new Promise((resolve) => {
        const sel = `.tabbar .tab[data-sid="${sid}"] .dot`
        const byClass = {}
        let frames = 0
        let lit = 0
        const t0 = performance.now()
        const tick = () => {
          const el = document.querySelector(sel)
          if (el) {
            frames++
            const bg = getComputedStyle(el).backgroundColor
            if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
              lit++
              const key = [...el.classList].filter((c) => c !== 'dot' && !c.startsWith('svelte-')).join(' ') || bg
              byClass[key] = (byClass[key] ?? 0) + 1
            }
          }
          if (performance.now() - t0 < ms) requestAnimationFrame(tick)
          else resolve({ frames, lit, byClass })
        }
        requestAnimationFrame(tick)
      }),
    { sid, ms },
  )
}
/** frames in which the dot was GREEN (the colour the bug abused) */
const greenFrames = (r) => (r.byClass.unread ?? 0) + (r.byClass.dirty ?? 0)

const dotClass = (page, sid) =>
  page.evaluate(
    (sid) => {
      const el = document.querySelector(`.tabbar .tab[data-sid="${sid}"] .dot`)
      if (!el) return 'NO-TAB'
      const cls = [...el.classList].filter((c) => c !== 'dot' && !c.startsWith('svelte-')).join(' ')
      return `${cls || 'off'}|${getComputedStyle(el).backgroundColor}`
    },
    sid,
  )

// ----------------------------------------------------------------------- run

// Test-local 4-arg check(c, name, pass, note) — the shape this file's cases are
// written against. (helpers/setup.mjs exports a 3-arg createChecker; passing it
// (case, name, cond, note) makes `cond` a truthy string and the test PASSES
// whatever it asserts. Same trap tabs-a11y.test.mjs documents.)
const results = []
function check(c, name, pass, note = '') {
  results.push({ c, name, pass: !!pass, note })
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${c} \u00b7 ${name}${note ? ` \u2014 ${note}` : ''}`)
}

const pageErrors = []
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
const browser = await launchBrowser()
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e)))

  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 })
  await page.waitForSelector('.sidebar .item', { timeout: 10000 })

  // ---- setup: two open tabs, B is the one under the cursor -----------------
  await page.click(`.sidebar .item[title="alpha background"]`)
  const aOpen = await poll(async () => (await page.locator(`.tabbar .tab[data-sid="${A}"]`).count()) === 1, 8000)
  await page.click(`.sidebar .item[title="beta foreground"]`)
  const bActive = await poll(
    async () => (await page.locator(`.tabbar .tab[data-sid="${B}"].active`).count()) === 1,
    8000,
  )
  check('T0', 'both sessions are open tabs', !!aOpen && (await page.locator(`.tabbar .tab[data-sid="${B}"]`).count()) === 1)
  check('T0', 'B is the active tab, A is a background tab', !!bActive)
  await sleep(1500) // let both tabs' first refetches land — A must start CLEAN

  // ---- T1: fetch windows and stray idles must not paint the dot ------------
  // `message.updated` on an open idle tab goes through sse.ts's scheduleRefetch,
  // which sets dirty:true and clears it ~350ms later when GET /message lands.
  // That in-flight window IS the reported flash. The bare `session.idle` is the
  // other half: `session.idle` is a STATE frame, so a bare idle for a session
  // nobody turned must not light the tab either.
  const before = (await page.evaluate(() => fetch('/__state').then((r) => r.json()))).msgFetches[A] ?? 0
  const watching = watchDotFor(page, A, 2500) // do NOT await yet — emit mid-window
  await sleep(200)
  await emit('message.updated', {
    sessionID: A,
    info: { id: `msg_${A}_a`, role: 'assistant', time: { created: NOW - 110_000, completed: NOW - 109_000 } },
  })
  await sleep(600)
  await emit('session.idle', { sessionID: A }) // stray: A has been idle all along
  const t1 = await watching
  const after = (await page.evaluate(() => fetch('/__state').then((r) => r.json()))).msgFetches[A] ?? 0
  check('T1', `the refetch really ran (${after - before} GET /message for A)`, after > before)
  check(
    'T1',
    `neither lit A's dot green (${t1.frames} frames, ${greenFrames(t1)} green, ${JSON.stringify(t1.byClass)})`,
    t1.frames > 30 && greenFrames(t1) === 0,
  )

  // ---- T2: a turn ENDING on the background tab is a real event -------------
  await turn(A)
  const lit = await poll(async () => (await dotClass(page, A)).startsWith('unread'), 6000)
  check('T2', "A's dot turns green when its turn ends out of view", !!lit, await dotClass(page, A))
  check('T2', 'the active tab B stayed dark', (await dotClass(page, B)) === 'off|rgba(0, 0, 0, 0)', await dotClass(page, B))

  // ---- T3: opening it clears the light -------------------------------------
  await page.click(`.tabbar .tab[data-sid="${A}"]`)
  const cleared = await poll(async () => (await dotClass(page, A)) === 'off|rgba(0, 0, 0, 0)', 6000)
  check('T3', "activating A clears its unread dot", !!cleared, await dotClass(page, A))

  // ---- T4: the other direction, so this is not a one-tab hack --------------
  await turn(B)
  const litB = await poll(async () => (await dotClass(page, B)).startsWith('unread'), 6000)
  check('T4', "B lights green when ITS turn ends in the background", !!litB, await dotClass(page, B))

  // ---- T5: the active tab never lights — you are looking at it -------------
  await page.click(`.tabbar .tab[data-sid="${B}"]`)
  await poll(async () => (await dotClass(page, B)) === 'off|rgba(0, 0, 0, 0)', 6000)
  const t5w = watchDotFor(page, B, 2200) // sample ACROSS the event, not before it
  await sleep(200)
  await turn(B)
  const t5 = await t5w
  await sleep(1200)
  check(
    'T5',
    `an idle turn on the ACTIVE tab never goes green (${t5.frames} frames, ${greenFrames(t5)} green, ${t5.byClass.busy ?? 0} amber)`,
    t5.frames > 30 && greenFrames(t5) === 0 && (t5.byClass.busy ?? 0) > 0 && (await dotClass(page, B)).startsWith('off'),
    await dotClass(page, B),
  )

  check('Z', 'no uncaught page errors', pageErrors.length === 0, pageErrors[0] ?? '')
  await ctx.close()
} finally {
  await browser.close()
  await new Promise((r) => server.close(r))
}

const failed = results.filter((r) => !r.pass).length
console.log(`\nRESULT: ${results.length - failed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
