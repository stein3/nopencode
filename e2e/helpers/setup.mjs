// Shared setup for e2e tests — env-configurable paths, browser launch, fixtures.
//
// Usage:
//   import { BASE, ENGINE, DIST, browser, seedSession, cleanup } from '../helpers/setup.mjs'
//
// Env vars (all have sane defaults for local dev):
//   BASE_URL       – chatserver URL        (default http://127.0.0.1:8123)
//   ENGINE_URL     – opencode engine URL   (default http://127.0.0.1:4096)
//   WEBTEST_DIR    – this e2e/ directory   (auto-detected)
//   WEBUI_DIST     – path to webui/dist    (default ../webui/dist relative to repo root)
//   CHROMIUM_PATH  – explicit chromium exe  (auto-detected via playwright)
//   SHOTS_DIR      – screenshot output     (default <WEBTEST_DIR>/shots)

import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

// ---- directory constants ---------------------------------------------------

// import.meta.dirname = e2e/helpers/; go up one level to e2e/ (the real root)
export const E2E_DIR = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '..')
export const REPO_ROOT = path.resolve(E2E_DIR, '..')

export const WEBTEST_DIR = process.env.WEBTEST_DIR || E2E_DIR
export const DIST = process.env.WEBUI_DIST || path.join(REPO_ROOT, 'webui', 'dist')
export const SHOTS_DIR = process.env.SHOTS_DIR || path.join(WEBTEST_DIR, 'shots')

// ---- server URLs -----------------------------------------------------------

export const BASE = process.env.BASE_URL || 'http://127.0.0.1:8123'
export const ENGINE = process.env.ENGINE_URL || 'http://127.0.0.1:4096'

// ---- chromium executable ---------------------------------------------------

function findChromium() {
  if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) {
    return process.env.CHROMIUM_PATH
  }

  // Playwright auto-install location
  const cacheDir = path.join(
    process.env.HOME || '/tmp',
    '.cache', 'ms-playwright',
  )
  if (fs.existsSync(cacheDir)) {
    const dirs = fs.readdirSync(cacheDir)
      .filter((d) => d.startsWith('chromium_headless_shell-'))
      .sort()
      .reverse()
    if (dirs.length) {
      const base = path.join(cacheDir, dirs[0])
      // Walk common sub-paths for the actual binary
      const candidates = [
        path.join(base, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
        path.join(base, 'chrome-linux', 'chrome'),
      ]
      for (const c of candidates) {
        if (fs.existsSync(c)) return c
      }
    }
  }

  // Fallback: let playwright find it
  return undefined
}

export const EXE = findChromium()

// ---- font / lib env setup (for headless Chromium on bare systems) ----------

function setupFontEnv() {
  const libs = [
    path.join(WEBTEST_DIR, 'fixtures', 'libs', 'lib', 'x86_64-linux-gnu'),
    path.join(WEBTEST_DIR, 'fixtures', 'libs', 'usr', 'lib', 'x86_64-linux-gnu'),
  ].filter((p) => fs.existsSync(p))

  if (libs.length) {
    process.env.LD_LIBRARY_PATH = [...libs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':')
  }

  const fc = path.join(WEBTEST_DIR, 'fixtures', 'fonts.conf')
  if (fs.existsSync(fc)) {
    process.env.FONTCONFIG_FILE = fc
  }
}

setupFontEnv()

// ---- browser launch --------------------------------------------------------

export async function launchBrowser(opts = {}) {
  const { chromium } = createRequire(path.join(WEBTEST_DIR, 'package.json'))('playwright-core')
  const launchOpts = {
    args: [
      '--no-sandbox',
      // Bypass SkFontMgr_FontConfigInterface crash on chromium_headless_shell
      // builds compiled without the fontconfig backend (e.g. revision 1234).
      // --use-gl=angle --use-angle=swiftshader forces software rendering,
      // preventing the GPU process from hitting the unimplemented fontconfig path.
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--disable-lcd-text',
      '--disable-font-subpixel-positioning',
      '--font-render-hinting=none',
    ],
    ...opts,
  }
  if (EXE) launchOpts.executablePath = EXE
  return chromium.launch(launchOpts)
}

// ---- fixture helpers -------------------------------------------------------

/**
 * Create a session with N noReply user messages (no LLM turns needed).
 * Returns the session ID.
 */
export async function seedSession(title, messageCount, engineUrl = ENGINE) {
  const r = await fetch(`${engineUrl}/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  if (!r.ok) throw new Error(`seed ${title}: POST /session ${r.status}`)
  const s = await r.json()

  for (let i = 1; i <= messageCount; i++) {
    const text = `msg ${i} — ${title} — ` + 'filler line for scroll height. '.repeat(6)
    const m = await fetch(`${engineUrl}/session/${s.id}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ noReply: true, parts: [{ type: 'text', text }] }),
    })
    if (!m.ok) throw new Error(`seed ${title}: message ${i} ${m.status}`)
  }
  return s.id
}

/**
 * Delete a session from the engine (cleanup).
 */
export async function deleteSession(sid, engineUrl = ENGINE) {
  try {
    const r = await fetch(`${engineUrl}/session/${sid}`, { method: 'DELETE' })
    return r.status
  } catch {
    return -1
  }
}

/**
 * Cleanup multiple sessions.
 */
export async function cleanup(sids, engineUrl = ENGINE) {
  for (const sid of sids.filter(Boolean)) {
    const status = await deleteSession(sid, engineUrl)
    if (status !== 200 && status !== 204) {
      console.log(`cleanup delete ${sid}: ${status}`)
    }
  }
}

// ---- test bookkeeping ------------------------------------------------------

export function createChecker() {
  let npass = 0
  let nfail = 0

  function check(name, cond, detail = '') {
    if (cond) {
      npass++
      console.log(`PASS ${name}${detail ? ' — ' + detail : ''}`)
    } else {
      nfail++
      console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`)
    }
  }

  function summary() {
    console.log(`\nRESULT: ${npass} passed, ${nfail} failed`)
    return nfail
  }

  return { check, summary, get npass() { return npass }, get nfail() { return nfail } }
}

// ---- screenshot helper (creates dir on demand) ----------------------------

export async function screenshot(page, name) {
  fs.mkdirSync(SHOTS_DIR, { recursive: true })
  const file = path.join(SHOTS_DIR, `${name}.png`)
  await page.screenshot({ path: file })
  return file
}
