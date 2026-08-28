// agent-label.test.mjs — embedded fake-engine test for per-message agent labels.
// Verifies user messages show the engine-stamped agent (titlecased), preserved
// through refetch/reload — the regression that motivated the fix (old
// normalizeMessages dropped `agent`, so labels fell back to 'opencode').
//
// Port 8153. Run: node e2e/embedded/agent-label.test.mjs

import path from 'node:path'
import fs from 'node:fs'
import http from 'node:http'
import { DIST, launchBrowser, screenshot } from '../helpers/setup.mjs'

const PORT = 8153
const BASE = `http://127.0.0.1:${PORT}`

// ============================== fake engine =================================

const SESSIONS = [
  { id: 'ses_abuild', title: 'agent-label build probe', agent: 'build' },
  { id: 'ses_aplan', title: 'agent-label plan probe', agent: 'plan' },
]

// Generate 4 user messages per session
const MESSAGES = {}
for (const s of SESSIONS) {
  MESSAGES[s.id] = []
  for (let i = 1; i <= 4; i++) {
    MESSAGES[s.id].push({
      info: {
        id: `msg_${s.id}_${i}`,
        role: 'user',
        agent: s.agent,
        time: { created: Date.now() - 120_000 + i * 1000 },
      },
      parts: [
        { id: `part_${s.id}_${i}`, type: 'text', text: `msg ${i} — ${s.title} — ${'filler '.repeat(8)}` },
      ],
    })
  }
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
      return json(res, SESSIONS.map((s) => ({
        id: s.id, title: s.title, created: Date.now() - 120_000, updated: Date.now() - 30_000,
        message_count: 4, cost: 0,
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
      const s = SESSIONS.find((x) => x.id === mSess[1])
      return json(res, s ? { id: s.id, title: s.title, revert: null } : { error: 'not found' }, s ? 200 : 404)
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

function check(name, pass, note = '') {
  results.push({ name, pass: !!pass, note })
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${note ? ` — ${note}` : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ================================ run =======================================

try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

  const browser = await launchBrowser()
  const page = await browser.newPage({ viewport: { width: 1280, height: 1900 } })
  page.on('pageerror', (e) => pageErrors.push(e.message))
  const pane = page.locator('.tabpane[style*="flex"]')

  try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20000 })
    await page.waitForSelector('.sidebar .item', { timeout: 10000 })
    await sleep(1200)

    // ---- CASE A: fresh open — labels correct ----------------------------------
    console.log('\nCASE A — fresh open labels')
    for (const s of SESSIONS) {
      await page.click(`.sidebar .item[title="${s.title}"]`)
      await pane.locator('.msg').first().waitFor({ timeout: 20000 })
      await sleep(1500)

      const roles = await pane.locator('.msg:not(.errtile) .role').allTextContents()
      const trimmed = roles.map((t) => t.trim())
      check(
        `[${s.agent}] user messages labeled "you"`,
        trimmed.every((r) => r === 'you' || r === 'Build' || r === 'Plan'),
        `labels: ${[...new Set(trimmed)].join(', ')}`,
      )
      check(
        `[${s.agent}] no bare 'opencode' fallback`,
        !trimmed.includes('opencode'),
      )
    }

    // ---- CASE B: reload — labels persist --------------------------------------
    console.log('\nCASE B — labels persist across reload')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.sidebar .item', { timeout: 10000 })
    await sleep(1200)

    for (const s of SESSIONS) {
      await page.click(`.sidebar .item[title="${s.title}"]`)
      await pane.locator('.msg').first().waitFor({ timeout: 20000 })
      await sleep(1500)

      const roles = await pane.locator('.msg:not(.errtile) .role').allTextContents()
      const trimmed = roles.map((t) => t.trim())
      check(
        `[${s.agent}] reload — user messages labeled "you"`,
        trimmed.every((r) => r === 'you' || r === 'Build' || r === 'Plan'),
        `labels: ${[...new Set(trimmed)].join(', ')}`,
      )
      check(
        `[${s.agent}] reload — no bare 'opencode' fallback`,
        !trimmed.includes('opencode'),
      )
    }

    await screenshot(page, 'agent-label')
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
