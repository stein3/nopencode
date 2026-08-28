// kbd.test.mjs — embedded fake-engine test for soft-keyboard / visualViewport fix.
// Mostly pure client-side: verifies viewport meta tag, dvh chain, and keyboard
// open/close driving --vvh updates. Minimal engine stubs needed.
//
// Port 8155. Run: node e2e/embedded/kbd.test.mjs

import path from 'node:path'
import fs from 'node:fs'
import http from 'node:http'
import { DIST, launchBrowser, screenshot, sleep } from '../helpers/setup.mjs'

const PORT = 8155
const BASE = `http://127.0.0.1:${PORT}`

// ============================== fake engine =================================

const SID = 'ses_kbd01'

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

    // ---- history (minimal) ---------------------------------------------------
    if (p === '/api/history/sessions') {
      return json(res, [
        { id: SID, title: 'kbd probe', created: Date.now() - 120_000, updated: Date.now() - 30_000, message_count: 0, cost: 0 },
      ])
    }
    if (p.startsWith('/api/history/session/')) return json(res, [])
    if (p.endsWith('/errors')) {
      if (req.method === 'GET') return json(res, [])
      return json(res, { ok: true })
    }

    // ---- engine ---------------------------------------------------------------
    if (p === '/oc/session/status') return json(res, {})
    if (p.startsWith('/oc/session/') && p.endsWith('/message')) return json(res, [])
    if (p.startsWith('/oc/session/')) return json(res, { id: SID, title: 'kbd probe', revert: null })
    if (p === '/oc/session' && req.method === 'POST') return json(res, { id: SID, title: 'kbd probe', revert: null })
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

function check(c, name, pass, note = '') {
  results.push({ c, name, pass: !!pass, note })
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${c} · ${name}${note ? ` — ${note}` : ''}`)
}

// ================================ run =======================================

const VP = { width: 800, height: 1280 }

try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

  const browser = await launchBrowser()

  try {
  // ---- Page A: real environment (keyboard closed) ----------------------------
  console.log('\nPAGE A — real environment')
  const ctxA = await browser.newContext({ viewport: VP })
  const pageA = await ctxA.newPage()
  pageA.on('pageerror', (e) => pageErrors.push(`A: ${e.message}`))
  await pageA.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 })
  await pageA.waitForSelector('.app', { timeout: 10000 })
  await sleep(1500)

  const meta = await pageA.evaluate(() => document.querySelector('meta[name="viewport"]')?.content ?? '')
  check('b1', 'meta has interactive-widget=resizes-content', meta.includes('interactive-widget=resizes-content'), meta)
  check('b2', 'meta has viewport-fit=cover', meta.includes('viewport-fit=cover'), '')

  const aState = await pageA.evaluate(() => ({
    h: getComputedStyle(document.querySelector('.app')).height,
    vvh: document.documentElement.style.getPropertyValue('--vvh'),
    innerH: window.innerHeight,
  }))
  check('c1', '.app height == viewport (1280px)', aState.h === `${VP.height}px`, `got ${aState.h}, innerHeight=${aState.innerH}`)
  check('c2', '--vvh absent when keyboard closed', aState.vvh === '', `got "${aState.vvh}"`)

  await pageA.locator('.tabpane[style*="flex"]').waitFor({ state: 'visible', timeout: 10000 })
  await pageA.locator('.tabpane[style*="flex"] #composer-input').click()
  await sleep(150)
  const focused = await pageA.evaluate(() => document.activeElement?.id === 'composer-input')
  check('c3', 'composer textarea focusable', focused)
  await screenshot(pageA, 'kbd-before')

  // ---- Page B: stubbed visualViewport (fallback path) -----------------------
  console.log('\nPAGE B — stubbed visualViewport')
  const ctxB = await browser.newContext({ viewport: VP })
  const pageB = await ctxB.newPage()
  pageB.on('pageerror', (e) => pageErrors.push(`B: ${e.message}`))
  await pageB.addInitScript(() => {
    const state = { height: window.innerHeight || 1280, scale: 1, offsetTop: 0 }
    window.__vvState = state
    const target = new EventTarget()
    const stub = {
      get height() { return state.height },
      get scale() { return state.scale },
      get offsetTop() { return state.offsetTop },
      addEventListener: (...a) => target.addEventListener(...a),
      removeEventListener: (...a) => target.removeEventListener(...a),
      dispatchEvent: (...a) => target.dispatchEvent(...a),
    }
    Object.defineProperty(window, 'visualViewport', { value: stub, configurable: true, writable: true })
    window.__vvDispatch = (type) => target.dispatchEvent(new Event(type))
  })
  await pageB.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 })
  await pageB.waitForSelector('.app', { timeout: 10000 })
  await sleep(500)

  const twoFrames = () => pageB.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))

  // keyboard open: innerHeight 1280, vv.height 840 → kb=440 → --vvh=840px
  await pageB.evaluate(() => { window.__vvState.height = 840; window.__vvDispatch('resize') })
  let okOpen = true, detOpen = ''
  try {
    await pageB.waitForFunction(() => document.documentElement.style.getPropertyValue('--vvh') === '840px', null, { timeout: 4000 })
  } catch { okOpen = false }
  const bOpen = await pageB.evaluate(() => ({
    vvh: document.documentElement.style.getPropertyValue('--vvh'),
    h: getComputedStyle(document.querySelector('.app')).height,
  }))
  if (bOpen.h !== '840px') okOpen = false
  detOpen = `--vvh="${bOpen.vvh}" .app=${bOpen.h}`
  check('d1', 'keyboard-open: --vvh=840px and .app height 840px', okOpen, detOpen)
  await screenshot(pageB, 'kbd-open')

  // keyboard closed: vv.height 1280 → kb=0 → property removed
  await pageB.evaluate(() => { window.__vvState.height = 1280; window.__vvDispatch('resize') })
  let okClosed = true
  try {
    await pageB.waitForFunction(() => document.documentElement.style.getPropertyValue('--vvh') === '', null, { timeout: 4000 })
  } catch { okClosed = false }
  const bClosed = await pageB.evaluate(() => ({
    vvh: document.documentElement.style.getPropertyValue('--vvh'),
    h: getComputedStyle(document.querySelector('.app')).height,
  }))
  if (bClosed.h !== `${VP.height}px`) okClosed = false
  check('d2', 'keyboard-closed: --vvh removed, .app back to 1280px', okClosed, `--vvh="${bClosed.vvh}" .app=${bClosed.h}`)

  // pinch-zoom guard: scale 1.5 must not update anything
  await pageB.evaluate(() => {
    window.__vvState.scale = 1.5
    window.__vvState.height = 400
    window.__vvDispatch('resize')
  })
  await twoFrames(); await twoFrames()
  const bPinch = await pageB.evaluate(() => ({
    vvh: document.documentElement.style.getPropertyValue('--vvh'),
    h: getComputedStyle(document.querySelector('.app')).height,
  }))
  check('d3', 'pinch-zoom (scale 1.5): no update fires', bPinch.vvh === '' && bPinch.h === `${VP.height}px`, `--vvh="${bPinch.vvh}" .app=${bPinch.h}`)

  // scroll wiring: keyboard "open" (height 840), scroll event only
  await pageB.evaluate(() => {
    window.__vvState.scale = 1
    window.__vvState.height = 840
    window.__vvDispatch('scroll')
  })
  let okScroll = true
  try {
    await pageB.waitForFunction(() => document.documentElement.style.getPropertyValue('--vvh') === '840px', null, { timeout: 4000 })
  } catch { okScroll = false }
  const bScroll = await pageB.evaluate(() => document.documentElement.style.getPropertyValue('--vvh'))
  check('d4', 'scroll event alone drives update via listener', okScroll, `--vvh="${bScroll}"`)
  await pageB.evaluate(() => { window.__vvState.height = 1280; window.__vvDispatch('scroll') })
  await pageB.waitForFunction(() => document.documentElement.style.getPropertyValue('--vvh') === '', null, { timeout: 4000 }).catch(() => {})
  await screenshot(pageB, 'kbd-after')

  // ---- global ---------------------------------------------------------------
  check('E', 'no page errors on either page', pageErrors.length === 0, pageErrors.join(' | '))
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
