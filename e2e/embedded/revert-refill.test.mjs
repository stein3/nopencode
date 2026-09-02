// revert-refill.test.mjs — embedded fake-engine test for the revert→composer-refill path
//
// Verifies: clicking ↩ on a user message (a) sends the revert POST to the
// engine, and (b) refills the composer textarea with the reverted message's
// text (when the composer is empty).
//
// Run: node e2e/embedded/revert-refill.test.mjs

import path from 'node:path'
import fs from 'node:fs'
import http from 'node:http'
import { DIST, launchBrowser, screenshot, sleep, poll, createChecker } from '../helpers/setup.mjs'

const PORT = 8170
const BASE = `http://127.0.0.1:${PORT}`
const TITLE = 'REVERT-REFILL-PROBE'

// ============================== fixtures =====================================

const REVERT_TEXT = `REVERT-ME-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

const sessions = {}
const sessionMsgs = {}

function makeSid() {
  return `ses_rr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
}

function buildSession(title) {
  const id = makeSid()
  sessions[id] = { id, title, revert: null }
  sessionMsgs[id] = []
  return sessions[id]
}

function addMessage(sid, text, role = 'user') {
  const id = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
  const msg = {
    id,
    role,
    parts: [{ id: `part_${id}`, type: 'text', text }],
    time: { created: Date.now() },
  }
  sessionMsgs[sid].push(msg)
  return msg
}

// ============================== fake engine ==================================

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain',
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = ''
    req.on('data', (c) => (buf += c))
    req.on('end', () => resolve(buf))
  })
}

function json(res, obj, code = 200) {
  const b = Buffer.from(JSON.stringify(obj))
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length })
  res.end(b)
}

const state = {
  revertRequests: [],  // { sid, body }
}

const server = http.createServer(async (req, res) => {
  const p = (req.path_url ??= req.url.split('?')[0])

  try {
    // ---- test introspection -------------------------------------------------
    if (p === '/__state') {
      return json(res, {
        sessions: Object.keys(sessions),
        revertRequests: state.revertRequests,
      })
    }

    // ---- history (chatserver stubs) ------------------------------------------
    if (p === '/api/history/sessions') {
      return json(res, Object.values(sessions).map((s) => ({
        id: s.id,
        title: s.title,
        created: Date.now() - 120_000,
        updated: Date.now() - 30_000,
        message_count: (sessionMsgs[s.id] ?? []).length,
        cost: 0,
      })))
    }
    if (p.endsWith('/errors')) {
      if (req.method === 'GET') return json(res, [])
      return json(res, { ok: true })
    }
    if (p.startsWith('/api/history/session/')) {
      const sid = p.split('/api/history/session/')[1]?.split('/')[0]
      return json(res, sessionMsgs[sid] ?? [])
    }

    // ---- engine stubs -------------------------------------------------------
    if (p === '/oc/session/status') return json(res, {})

    // ---- SSE (EventSource needs text/event-stream) ----
    if (p === '/oc/event') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      })
      res.write('retry: 1000\n\n')
      // Keep connection open until client disconnects
      req.on('close', () => {})
      return
    }

    // GET /oc/session/{id} — return session info for the live path
    const mSession = p.match(/^\/oc\/session\/([^/]+)$/)
    if (mSession && req.method === 'GET') {
      const sid = mSession[1]
      const s = sessions[sid]
      if (s) return json(res, { id: s.id, title: s.title, revert: null })
      return json(res, { error: 'not found' }, 404)
    }

    // GET /oc/session/{id}/message — return messages for that session
    const mMsg = p.match(/^\/oc\/session\/([^/]+)\/message$/)
    if (mMsg && req.method === 'GET') {
      return json(res, sessionMsgs[mMsg[1]] ?? [])
    }

    // POST /oc/session/{id}/revert — revert the session
    const mRevert = p.match(/^\/oc\/session\/([^/]+)\/revert$/)
    if (mRevert && req.method === 'POST') {
      const sid = mRevert[1]
      const body = JSON.parse((await readBody(req)) || '{}')
      state.revertRequests.push({ sid, body })

      // Remove the target message and everything after it
      const msgs = sessionMsgs[sid] ?? []
      const mid = body.messageID
      if (mid) {
        const idx = msgs.findIndex((m) => m.id === mid)
        if (idx >= 0) {
          sessionMsgs[sid] = msgs.slice(0, idx)
        }
      }

      // Return a session object with revert info (realistic engine shape)
      return json(res, {
        id: sid,
        title: sessions[sid]?.title ?? 'session',
        revert: mid ? { messageID: mid } : null,
      })
    }

    // POST /oc/session — create a session
    if (p === '/oc/session' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}')
      const s = buildSession(body.title ?? 'New session')
      return json(res, s)
    }

    // POST /oc/session/{id}/message — create a message (noReply seed path)
    const mCreateMsg = p.match(/^\/oc\/session\/([^/]+)\/message$/)
    if (mCreateMsg && req.method === 'POST') {
      const sid = mCreateMsg[1]
      const body = JSON.parse((await readBody(req)) || '{}')
      if (!sessionMsgs[sid]) sessionMsgs[sid] = []
      const text = body.parts?.[0]?.text ?? ''
      const msg = addMessage(sid, text)
      return json(res, { info: msg, parts: msg.parts })
    }

    // DELETE /oc/session/{id}
    const mDel = p.match(/^\/oc\/session\/([^/]+)$/)
    if (mDel && req.method === 'DELETE') {
      delete sessions[mDel[1]]
      delete sessionMsgs[mDel[1]]
      return json(res, {})
    }

    if (p === '/oc/config/providers')
      return json(res, { providers: [{ id: 'opencode', models: {} }] })
    if (p === '/oc/path') return json(res, { directory: '/workspace' })
    if (p === '/oc/mcp') return json(res, {})
    if (p.startsWith('/oc/')) return json(res, [])

    // ---- statics (webui/dist) -----------------------------------------------
    const rel = p === '/' ? '/index.html' : p
    const full = fs.realpathSync(path.join(DIST, rel))
    if (!full.startsWith(fs.realpathSync(DIST)) || !fs.statSync(full).isFile())
      return json(res, { error: 'missing' }, 404)
    const ct = MIME[path.extname(full)] ?? 'application/octet-stream'
    const b = fs.readFileSync(full)
    res.writeHead(200, {
      'Content-Type': ct,
      'Content-Length': b.length,
      'Cache-Control': 'no-store',
    })
    res.end(b)
  } catch (e) {
    try {
      json(res, { error: String(e) }, 500)
    } catch {
      /* headers already sent */
    }
  }
})

// ================================ run =======================================

const ck = createChecker()
let pageErrors = []
const consoleMessages = []

try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
  console.log(`fake engine on :${PORT}`)

  // ---- seed the probe session: user msg + assistant reply -------------------
  const sess = buildSession(TITLE)
  const userMsg = addMessage(sess.id, REVERT_TEXT, 'user')
  const assistantMsg = addMessage(sess.id, 'This is a fake assistant reply.', 'assistant')
  console.log('seeded', sess.id, '| user msg:', userMsg.id)

  const browser = await launchBrowser()
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.on('pageerror', (e) => pageErrors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warn') {
      consoleMessages.push(`[${m.type()}] ${m.text()}`)
    }
  })

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 })
    await page.waitForSelector('.sidebar .item', { timeout: 10000 })
    await sleep(1200)

    // ---- open the probe session from the sidebar
    await page.click(`.sidebar .item[title="${TITLE}"]`)
    await sleep(2000)

    // Verify the session opened with user + assistant messages
    // NOTE: assistant messages have class "msg" (no ".assistant" class) —
    // Transcript only applies class:user for user-role messages.
    const userRows = await page.locator('.tabpane:visible .msg.user').count()
    const assistRows = await page.locator('.tabpane:visible .msg:not(.user)').count()
    console.log('[init] user rows:', userRows, '| assistant rows:', assistRows)
    ck.check('T1 session opened with user msg', userRows >= 1, `got ${userRows}`)
    ck.check('T2 session opened with assistant msg', assistRows >= 1, `got ${assistRows}`)

    // ---- verify composer is empty before revert
    const composerBefore = await page.inputValue('#composer-input:visible').catch(() => '(not found)')
    console.log('[init] composer value:', JSON.stringify(composerBefore))
    ck.check('T3 composer empty before revert', composerBefore === '', `got: ${JSON.stringify(composerBefore)}`)

    // ---- hover the user message and click the revert button
    const userRow = page.locator('.tabpane:visible .msg.user').first()
    await userRow.hover()
    await sleep(200)

    const revertBtn = userRow.locator('button.act[title="Revert session to before this message"]')
    const btnVisible = await revertBtn.isVisible()
    console.log('[init] revert button visible:', btnVisible)
    ck.check('T4 revert button visible on hover', btnVisible)

    // Capture state before click
    const stateBefore = await fetch(`${BASE}/__state`).then(r => r.json())
    console.log('[before] revert requests:', stateBefore.revertRequests.length)

    // ---- click the revert button
    await revertBtn.click()
    console.log('[action] revert button clicked')

    // Wait for the revert to process (POST + refetch + DOM update)
    await sleep(3000)

    // ---- assert (a): the fake engine received the revert POST
    const stateAfter = await fetch(`${BASE}/__state`).then(r => r.json())
    console.log('[after] revert requests:', JSON.stringify(stateAfter.revertRequests))
    ck.check('T5 engine received revert POST', stateAfter.revertRequests.length > 0,
      `got ${stateAfter.revertRequests.length} request(s)`)

    if (stateAfter.revertRequests.length > 0) {
      const revReq = stateAfter.revertRequests[0]
      ck.check('T6 revert POST has correct session ID', revReq.sid === sess.id,
        `got ${revReq.sid}, expected ${sess.id}`)
      ck.check('T7 revert POST has messageID', !!revReq.body?.messageID,
        `got ${JSON.stringify(revReq.body)}`)
    }

    // ---- assert (b): composer textarea contains the reverted message text
    const composerAfter = await page.inputValue('#composer-input:visible').catch(() => '(not found)')
    console.log('[after] composer value:', JSON.stringify(composerAfter))
    ck.check('T8 composer refilled with reverted text', composerAfter === REVERT_TEXT,
      `got: ${JSON.stringify(composerAfter).slice(0, 100)}`)

    // ---- additional diagnostics
    const composerEmpty = composerAfter === ''
    if (composerEmpty) {
      console.log('\n=== DIAGNOSTICS: composer is still empty after revert ===')

      // Check if the textarea exists and is visible
      const taVisible = await page.locator('#composer-input:visible').isVisible().catch(() => false)
      console.log('textarea visible:', taVisible)

      // Check the textarea's parent pane
      const paneStyle = await page.locator('.tabpane:visible').getAttribute('style').catch(() => '(not found)')
      console.log('active pane style:', paneStyle)

      // Use page.evaluate to inspect the app state
      const diagInfo = await page.evaluate(() => {
        // Try to access Svelte component state
        const ta = document.querySelector('#composer-input')
        return {
          textareaExists: !!ta,
          textareaValue: ta?.value ?? '(null)',
          textareaDisplay: ta ? getComputedStyle(ta).display : '(no ta)',
        }
      })
      console.log('textarea DOM state:', JSON.stringify(diagInfo))
    }

    await screenshot(page, 'revert-refill-result')

  } finally {
    await browser.close()
  }
} finally {
  await new Promise((r) => server.close(r))
}

// =============================== summary ====================================

const fails = ck.summary()
if (pageErrors.length) {
  console.log(`\npage errors observed (${pageErrors.length}):`)
  for (const e of [...new Set(pageErrors)].slice(0, 5)) console.log('  •', e.slice(0, 220))
}
if (consoleMessages.length) {
  console.log(`\nconsole messages (${consoleMessages.length}):`)
  for (const m of [...new Set(consoleMessages)].slice(0, 10)) console.log('  •', m.slice(0, 220))
}
process.exitCode = fails ? 1 : 0
