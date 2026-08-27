// Verify composer file uploads end-to-end (headless):
//   1. attach button path: setInputFiles(png + .ts) -> tray chips (thumb + ext badge)
//   2. drag & drop: synthetic File drop on the pane -> dropping affordance + chip lands
//   3. oversize guard: 11MB file -> inline "larger than" error
//   4. transcript rendering: seeded noReply user message with file parts ->
//      image opens lightbox, code file renders filename chip
// Seeds its own fixture session (noReply POST = no LLM turn) and deletes it after.
// Assumes chatserver at :8123 (fresh dist) + engine at :4096.
import path from 'node:path'
import fs from 'node:fs'
import { BASE, E2E_DIR, launchBrowser, createChecker, screenshot, SHOTS_DIR } from '../helpers/setup.mjs'

const { check, summary } = createChecker()

// --- fixtures -----------------------------------------------------------
// 1x1 PNG — MUST be a real decodable image: the engine eagerly decodes image
// file parts at prompt time and rejects the WHOLE message on bad bytes
// (ImageDecodeError -> session.error, nothing persists). Verified v1.18.18.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const TMP = path.join(E2E_DIR, 'tmp-uploads')
fs.mkdirSync(TMP, { recursive: true })
const shot = (buf) => fs.writeFileSync(path.join(TMP, 'shot.png'), Buffer.from(buf, 'base64'))
shot(PNG_B64)
fs.writeFileSync(path.join(TMP, 'app.ts'), 'export const answer = 42\n')
const HUGE = { name: 'huge.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(11 * 1024 * 1024, 7) }

// --- seed render fixture -------------------------------------------------
// NOTE: noReply POSTs reject image file parts (400 BadRequest — verified
// against v1.18.18; only text/plain rides noReply). Images persist ONLY via
// prompt_async, so seed through it and abort the turn immediately.
const mkPart = (mime, b64, filename) => ({ type: 'file', mime, url: `data:${mime};base64,${b64}`, filename })
const jpost = (url, body) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const seedRes = await jpost(BASE + '/oc/session', { title: 'uploads-render-fixture' })
const seedSes = await seedRes.json()
await jpost(`${BASE}/oc/session/${seedSes.id}/prompt_async`, {
  parts: [
    { type: 'text', text: 'render fixture only, will be aborted' },
    mkPart('image/png', PNG_B64, 'diagram.png'),
    mkPart('text/typescript', Buffer.from('export const answer = 42\n').toString('base64'), 'answer.ts'),
  ],
})
await new Promise((r) => setTimeout(r, 1500))
await jpost(`${BASE}/oc/session/${seedSes.id}/abort`, {})
for (let i = 0; i < 20; i++) {
  const st = await (await fetch(`${BASE}/oc/session?id=${seedSes.id}`).catch(() => fetch(BASE + '/oc/session'))).json()
  const row = Array.isArray(st) ? st.find((s) => s.id === seedSes.id) : st
  if (row && !row.busy) break
  await new Promise((r) => setTimeout(r, 500))
}
// confirm the file parts actually persisted before blaming the UI
const seeded = await (await fetch(`${BASE}/oc/session/${seedSes.id}/message`)).json()
const seedUser = seeded.find((m) => m.info?.role === 'user')
const seedFiles = (seedUser?.parts ?? []).filter((p) => p.type === 'file')
check(seedFiles.length === 2, `fixture seeded with 2 file parts (got ${seedFiles.length})`)
if (seedFiles.length !== 2) {
  console.log('SEED FAILED - engine rejected the fixture; aborting before browser work')
  await fetch(`${BASE}/oc/session/${seedSes.id}`, { method: 'DELETE' }).catch(() => {})
  process.exit(1)
}
console.log('fixture session:', seedSes.id)

// --- browser ------------------------------------------------------------
const browser = await launchBrowser()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message))

const PANE = '.tabpane[style*="flex"]'
const composer = () => page.locator(`${PANE} .composer`)
const chips = () => page.locator(`${PANE} .tray .chip`)

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1800)

  // fresh chat tab (sidebar .new button; open drawer first if needed)
  if (!(await page.locator('.sidebar').isVisible().catch(() => false))) {
    await page.locator('button.burger').click()
    await page.waitForTimeout(300)
  }
  await page.locator('.sidebar .new').click()
  await page.waitForTimeout(600)
  check((await chips().count()) === 0, 'tray starts empty')

  // 1. attach-button path
  await page.setInputFiles(`${PANE} input[type="file"]`, [path.join(TMP, 'shot.png'), path.join(TMP, 'app.ts')])
  await page.waitForTimeout(300)
  check((await chips().count()) === 2, 'two chips staged via picker')
  check((await page.locator(`${PANE} .chip .cthumb`).count()) === 1, 'image chip shows thumbnail')
  const ext = (await page.locator(`${PANE} .chip .cext`).first().textContent()) ?? ''
  check(ext.trim() === 'TS', `code chip badge is TS (got "${ext.trim()}")`)
  check(((await composer().getAttribute('class')) ?? '').includes('hastray') === false, 'box keeps its own class')
  await screenshot(page, 'uploads-tray')

  // 2. drag & drop (synthetic File drag over the pane)
  await page.evaluate(() => {
    const pane = document.querySelector('.tabpane[style*="flex"]')
    const dt = new DataTransfer()
    dt.items.add(new File(['dropped-content'], 'dropped.py', { type: 'text/x-python' }))
    for (const type of ['dragenter', 'dragover']) {
      const ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt })
      pane.dispatchEvent(ev)
    }
  })
  await page.waitForTimeout(200)
  check(await page.locator(`${PANE} .drophint`).isVisible(), 'drop hint visible while dragging')
  check(
    ((await composer().getAttribute('class')) ?? '').includes('dropping'),
    'composer gets .dropping affordance',
  )
  await screenshot(page, 'uploads-dragover')
  await page.evaluate(() => {
    const pane = document.querySelector('.tabpane[style*="flex"]')
    const dt = new DataTransfer()
    dt.items.add(new File(['dropped-content'], 'dropped.py', { type: 'text/x-python' }))
    pane.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
  })
  await page.waitForTimeout(300)
  check((await chips().count()) === 3, 'synthetic drop lands third chip (PY)')
  // clear the drag state cleanly (real drops reset it; our synthetic one needs dragleave)
  await page.evaluate(() => {
    const pane = document.querySelector('.tabpane[style*="flex"]')
    pane.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true, relatedTarget: null }))
  })

  // 3. oversize guard
  await page.setInputFiles(`${PANE} input[type="file"]`, [HUGE])
  await page.waitForTimeout(300)
  const errText = (await page.locator(`${PANE} .composer .error`).first().textContent()) ?? ''
  check(errText.includes('larger than'), `oversize error shown (got "${errText.trim()}")`)
  await screenshot(page, 'uploads-oversize')

  // remove one chip works (3 staged: png + ts + dropped.py; huge.bin was rejected)
  await page.locator(`${PANE} .chip .crm`).first().click()
  await page.waitForTimeout(150)
  check((await chips().count()) === 2, 'remove button deletes a chip')

  // 4. transcript rendering of stored file parts (fresh load so the sidebar
  //    list includes the just-seeded fixture)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  await page
    .locator(`.sidebar .item:has-text("uploads-render-fixture")`)
    .first()
    .click()
  await page.waitForTimeout(1200)
  const img = page.locator(`${PANE} .msgimg img`)
  check((await img.count()) === 1, 'stored image part renders as message thumbnail')
  const fname = (await page.locator(`${PANE} .msgfile .fname`).first().textContent()) ?? ''
  check(fname.includes('answer.ts'), `stored code part renders as filename chip (got "${fname}")`)
  await img.click()
  await page.waitForTimeout(400)
  check(await page.locator('.lightbox img, .lb img, img[src^="data:image"]').last().isVisible().catch(() => false), 'lightbox opens from message thumb')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  await page.locator(`${PANE}`).screenshot({ path: path.join(SHOTS_DIR, 'uploads-transcript.png') })
} finally {
  // cleanup fixture session
  await fetch(`${BASE}/oc/session/${seedSes.id}`, { method: 'DELETE' }).catch(() => {})
  await browser.close()
}
process.exit(summary())
