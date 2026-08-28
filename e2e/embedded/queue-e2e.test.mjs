// Hermetic e2e test for the webui local-hold message queue.
//
// Serves webui/dist from an in-process fake opencode engine (no real LLM turn,
// deterministic timing) + drives the built UI with Playwright. Verifies:
//   1. While a turn is running, sending another prompt HOLDS it locally (no
//      second prompt_async call to the engine) and renders it as a `.msg.user.queued`
//      row with a "queued" badge.
//   2. Cancel (↩) on a queued message removes it locally; the engine never
//      receives it, and the running turn is unaffected.
//   3. When the running turn emits session.idle, the held prompt is dispatched
//      (prompt_async called) in order; the queued row is replaced by a real one.
//   4. Posted user messages no longer expose a Delete (🗑) action; queued
//      messages expose only Cancel (↩) and not Fork (⑂).
//
// Run:  node e2e/utilities/verify-queue-e2e.mjs
// Needs: a built webui/dist (npm run build) and a chromium_headless_shell in
//        ~/.cache/ms-playwright (resolved by helpers/setup.mjs).

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { launchBrowser, createChecker, sleep, DIST } from '../helpers/setup.mjs'

const PORT = +(process.env.PORT || 8213)
const DIST_DIR = DIST
// Turns never auto-finish; the test drives session.idle explicitly via /__ctl
// so the busy window is exactly as long as we need it to be.
const TURN_MS = 100000

// ---------------------------------------------------------------- fake engine

let sidc = 0
const sessions = new Map() // sid -> { id, title, prompts[], n, busy, idleTimer }
const globalPrompts = [] // { sid, n, text, t }  (prompt_async calls, in order)
const sseClients = []

function emit(type, props) {
  const chunk = `data: ${JSON.stringify({ type, properties: props })}\n\n`
  for (const res of sseClients) {
    try { res.write(chunk) } catch { /* dropped connection */ }
  }
}

function emitIdle(sid) {
  const s = sessions.get(sid)
  if (!s) return
  if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null }
  emit('session.idle', { sessionID: sid })
  s.busy = false
}

function makeSession() {
  const id = `ses_qe${++sidc}`
  const s = { id, title: `qe-${id}`, prompts: [], n: 0, busy: false, idleTimer: null }
  sessions.set(id, s)
  return s
}

function sessionInfo(s) {
  return { id: s.id, title: s.title, revert: null }
}

function messagesOf(s) {
  return s.prompts.map((p) => ({
    info: {
      id: p.mid, role: 'user', sessionID: s.id,
      time: { created: p.t }, agent: p.agent, model: p.model,
    },
    parts: p.parts,
  }))
}

// ---------------------------------------------------------------- http server

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json',
}

function sendJson(res, obj, code = 200) {
  const b = Buffer.from(JSON.stringify(obj))
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length })
  res.end(b)
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath
  const full = path.join(DIST_DIR, rel)
  if (!full.startsWith(DIST_DIR) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404); res.end('not found')
    return
  }
  const ext = path.extname(full)
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  })
  fs.createReadStream(full).pipe(res)
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => { data += c; if (data.length > 1e7) req.destroy() })
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}) } catch { resolve({}) }
    })
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const p = url.pathname
  const method = req.method

  // ---- SSE ----
  if (p === '/oc/event') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    })
    res.write('retry: 1000\n\n')
    sseClients.push(res)
    res.on('close', () => {
      const i = sseClients.indexOf(res)
      if (i >= 0) sseClients.splice(i, 1)
    })
    return
  }

  // ---- test control + introspection ----
  if (p === '/__state' && method === 'GET') {
    return sendJson(res, {
      sids: [...sessions.keys()],
      prompts: globalPrompts.map((x) => ({ sid: x.sid, n: x.n, text: x.text })),
      busy: Object.fromEntries([...sessions].map(([k, v]) => [k, v.busy])),
    })
  }
  if (p === '/__ctl' && method === 'POST') {
    const body = await readBody(req)
    if (body.action === 'idle' && body.sid) emitIdle(body.sid)
    return sendJson(res, { ok: true })
  }

  // ---- session lifecycle ----
  if (p === '/oc/session' && method === 'POST') {
    const s = makeSession()
    return sendJson(res, sessionInfo(s))
  }
  if (p === '/oc/session' && method === 'GET') {
    return sendJson(res, [...sessions.values()].map(sessionInfo))
  }
  // MUST precede the /oc/session/([^/]+) sid regex below (else "status" is
  // treated as a session id and 404s).
  if (p === '/oc/session/status') {
    return sendJson(res, Object.fromEntries([...sessions].map(([k, v]) => [k, { type: v.busy ? 'busy' : 'idle', state: v.busy ? 'running' : 'idle' }])))
  }
  const m = p.match(/^\/oc\/session\/([^/]+)$/)
  if (m) {
    const s = sessions.get(m[1])
    if (method === 'GET') return sendJson(res, s ? sessionInfo(s) : { error: 'no' }, s ? 200 : 404)
    if (method === 'DELETE') return sendJson(res, { ok: true })
    if (method === 'PATCH') return sendJson(res, { ok: true })
    return sendJson(res, {}, 200)
  }
  const msgRe = p.match(/^\/oc\/session\/([^/]+)\/message$/)
  if (msgRe && method === 'GET') {
    const s = sessions.get(msgRe[1])
    return sendJson(res, s ? messagesOf(s) : [])
  }
  const paRe = p.match(/^\/oc\/session\/([^/]+)\/prompt_async$/)
  if (paRe && method === 'POST') {
    const s = sessions.get(paRe[1])
    if (!s) { res.writeHead(404); return res.end() }
    const body = await readBody(req)
    const parts = body.parts ?? [{ type: 'text', text: '' }]
    const text = parts[0]?.text ?? ''
    s.n += 1
    const mid = `msg_u${s.n}`
    const t = Date.now()
    s.prompts.push({ n: s.n, mid, text, parts, agent: body.agent, model: body.model, t })
    globalPrompts.push({ sid: s.id, n: s.n, text, t })
    emit('message.updated', {
      info: { id: mid, role: 'user', sessionID: s.id, time: { created: t }, agent: body.agent, model: body.model, parts },
    })
    emit('session.busy', { sessionID: s.id })
    s.busy = true
    if (s.idleTimer) clearTimeout(s.idleTimer)
    s.idleTimer = setTimeout(() => emitIdle(s.id), TURN_MS)
    res.writeHead(204); return res.end()
  }

  // ---- chatserver-style history stubs (the webui calls these too) ----
  if (p === '/api/history/sessions') return sendJson(res, [])
  if (p.startsWith('/api/history/session/') && p.endsWith('/changes')) return sendJson(res, [])
  if (p.startsWith('/api/history/session/') && p.endsWith('/errors')) {
    if (method === 'DELETE') return sendJson(res, { ok: true })
    if (method === 'POST') return sendJson(res, { ok: true })
    return sendJson(res, [])
  }
  if (p.startsWith('/api/history/session/')) return sendJson(res, [])
  if (p === '/api/search') return sendJson(res, [])

  // ---- engine capability stubs ----
  if (p === '/oc/session/status') return sendJson(res, {})
  if (p === '/oc/config/providers') return sendJson(res, { providers: [{ id: 'opencode', models: { 'x-preview-f-free': { id: 'x-preview-f-free' } } }] })
  if (p === '/oc/path') return sendJson(res, { directory: '/workspace' })
  if (p === '/oc/mcp') return sendJson(res, {})
  if (p === '/oc/agent') return sendJson(res, [])
  if (p === '/oc/permission') return sendJson(res, [])
  if (p === '/oc/question') return sendJson(res, [])
  if (p === '/oc/command') return sendJson(res, [])
  if (p === '/oc/skill') return sendJson(res, [])
  const todoRe = p.match(/^\/oc\/session\/[^/]+\/todo$/)
  if (todoRe) return sendJson(res, [])

  // ---- static dist ----
  if (method === 'GET') return serveStatic(res, p)
  sendJson(res, {}, 200)
})

// ---------------------------------------------------------------- test drive

const { check, summary } = createChecker()
let currentSid = null

await new Promise((r) => server.listen(PORT, r))
console.log(`fake engine + dist on http://127.0.0.1:${PORT}`)

const browser = await launchBrowser()
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE.ERR:', m.text()) })
page.on('response', (r) => { if (r.status() >= 400) console.log('HTTP', r.status(), r.url()) })

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' })
// On load the app may show an empty state (no active composer) until a chat is
// opened, so wait for the New chat affordance rather than a textarea.
await page.waitForSelector('button[title="New chat"], button:has-text("New chat")', { timeout: 30000 })

const state = () => page.evaluate(async () => (await fetch('/__state')).json())
const idleNow = (sid) => fetch(`http://127.0.0.1:${PORT}/__ctl`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'idle', sid }),
})

async function newChat() {
  const before = (await state()).sids
  await page.locator('button[title="New chat"], button:has-text("New chat")').first().click()
  await page.waitForFunction(async (b) => {
    const s = await (await fetch('/__state')).json()
    return s.sids.length > b.length
  }, before, { timeout: 10000 })
  const after = (await state()).sids
  currentSid = after[after.length - 1]
  await page.waitForSelector('textarea:visible', { timeout: 10000 })
  await sleep(300)
}

async function send(text) {
  const ta = page.locator('textarea').filter({ visible: true }).first()
  await ta.fill(text)
  await ta.press('Enter')
}

async function users() {
  return page.evaluate(() => {
    const pane = [...document.querySelectorAll('.tabpane')].find((p) => getComputedStyle(p).display !== 'none')
    if (!pane) return []
    return [...pane.querySelectorAll('.msg.user')].map((u) => ({
      queued: u.classList.contains('queued'),
      badge: u.querySelector('.qbadge')?.textContent ?? null,
      acts: [...u.querySelectorAll('.acts .act')].map((b) => b.getAttribute('title')),
    }))
  })
}

async function waitBusy() {
  await page.waitForFunction(() => {
    const pane = [...document.querySelectorAll('.tabpane')].find((p) => getComputedStyle(p).display !== 'none')
    return pane && pane.querySelector('.msg.user') && pane.querySelector('.cylon')
  }, undefined, { timeout: 15000, polling: 200 })
}

try {
  // ===== Scenario 1: hold + cancel =====
  await newChat()
  await send('alpha')
  await waitBusy()
  let st = await state()
  let us = await users()
  const alphaSid = st.prompts[0].sid
  check('S1 send A → 1 prompt_async to engine', st.prompts.length === 1 && st.prompts[0].text === 'alpha')
  check('S1 A renders as a posted (non-queued) user message', us.length === 1 && us[0].queued === false)
  check('S1 posted message has NO Delete action', !us[0].acts.includes('Delete message'))

  // send B while A is running → must be held locally
  await send('beta')
  await page.waitForFunction(() => {
    const pane = [...document.querySelectorAll('.tabpane')].find((p) => getComputedStyle(p).display !== 'none')
    return pane && pane.querySelector('.msg.user.queued')
  }, undefined, { timeout: 8000, polling: 150 })
  st = await state()
  us = await users()
  const queued = us.find((u) => u.queued)
  check('S1 send B while busy → held locally (no 2nd prompt_async)', st.prompts.length === 1, `prompts=${st.prompts.length}`)
  check('S1 B renders as a queued row with "queued" badge', !!queued && queued.badge === 'queued')
  check('S1 queued row exposes ONLY Cancel (no Fork/Delete)', queued && queued.acts.length === 1 && queued.acts[0] === 'Cancel queued message', queued ? queued.acts.join('|') : 'none')
  check('S1 running turn unaffected (still 1 posted + 1 queued)', us.length === 2 && us.filter((u) => !u.queued).length === 1)

  // cancel the queued message
  await page.locator('.msg.user.queued .act[title="Cancel queued message"]').click()
  await page.waitForFunction(() => {
    const pane = [...document.querySelectorAll('.tabpane')].find((p) => getComputedStyle(p).display !== 'none')
    return pane && !pane.querySelector('.msg.user.queued')
  }, undefined, { timeout: 8000, polling: 150 })
  st = await state()
  us = await users()
  check('S1 after cancel → queued row gone', !us.some((u) => u.queued))
  check('S1 after cancel → B never reached the engine', st.prompts.length === 1, `prompts=${st.prompts.length}`)

  // finish A's turn → pumpQueue finds an empty queue, nothing new dispatched
  await idleNow(alphaSid)
  await page.waitForFunction(() => {
    const pane = [...document.querySelectorAll('.tabpane')].find((p) => getComputedStyle(p).display !== 'none')
    return pane && !pane.querySelector('.cylon')
  }, undefined, { timeout: 8000, polling: 150 })
  st = await state()
  check('S1 after A idle → still only 1 prompt_async (B was cancelled)', st.prompts.length === 1, `prompts=${st.prompts.length}`)

  // ===== Scenario 2: hold + dispatch-on-idle (order preserved) =====
  await newChat()
  await send('gamma')
  await waitBusy()
  await send('delta')
  await page.waitForFunction(() => {
    const pane = [...document.querySelectorAll('.tabpane')].find((p) => getComputedStyle(p).display !== 'none')
    return pane && pane.querySelector('.msg.user.queued')
  }, undefined, { timeout: 8000, polling: 150 })
  st = await state()
  us = await users()
  const gammaSid = st.prompts.at(-1).sid
  const s2 = () => st.prompts.filter((p) => p.sid === gammaSid)
  check('S2 send D while busy → held locally (no 2nd prompt_async yet)',
    s2().length === 1 && s2()[0].text === 'gamma', s2().map((x) => x.text).join(','))
  check('S2 D held as queued row', us.some((u) => u.queued && u.badge === 'queued'))

  // finish gamma's turn → webui must dispatch delta (same session).
  await idleNow(gammaSid)
  await page.waitForFunction(async (sid) => {
    const s = await (await fetch('/__state')).json()
    return s.prompts.filter((p) => p.sid === sid).length === 2
  }, gammaSid, { timeout: 8000, polling: 150 })
  st = await state()
  const s2now = st.prompts.filter((p) => p.sid === gammaSid)
  check('S2 on gamma idle → delta dispatched (2 prompt_async calls, order preserved)',
    s2now.length === 2 && s2now[0].text === 'gamma' && s2now[1].text === 'delta',
    s2now.map((x) => x.text).join('→'))

  // clear delta's own busy window so the UI settles (delta was dispatched,
  // not cancelled, so it must NOT reappear as a queued row)
  await idleNow(gammaSid)
  await page.waitForFunction(() => {
    const pane = [...document.querySelectorAll('.tabpane')].find((p) => getComputedStyle(p).display !== 'none')
    return pane && !pane.querySelector('.msg.user.queued')
  }, undefined, { timeout: 8000, polling: 150 })
  us = await users()
  check('S2 after dispatch → no queued rows remain', !us.some((u) => u.queued))
  check('S2 posted gamma/delta have Revert+Fork, no Delete',
    us.filter((u) => !u.queued).every((u) => u.acts.includes('Revert session to before this message') && u.acts.includes('Fork a new session from before this message') && !u.acts.includes('Delete message')))
} catch (e) {
  console.log('TEST ERROR:', e.message)
  check('test ran without throwing', false, e.message)
} finally {
  await browser.close()
  server.close()
  const fails = summary()
  process.exit(fails ? 1 : 0)
}
