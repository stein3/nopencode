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

// shots/ is git-ignored (e2e/.gitignore), so a FRESH checkout — every CI runner —
// has no such directory. screenshot() used to create it on demand, but a lot of
// tests write straight into SHOTS_DIR (page.screenshot / locator.screenshot /
// fs.writeFileSync) and those bypass it: the first direct write dies with ENOENT,
// and whether a test survives depends on whether some earlier screenshot() call
// happened to create the dir. ws-group.test.mjs hit exactly that in CI — all its
// DOM checks passed, then its FIRST raw write (line ~204) crashed the run.
// Create it once at import so the directory never depends on test ordering.
// Best-effort: shots are diagnostics, so a read-only FS must not take every
// suite down with it.
try { fs.mkdirSync(SHOTS_DIR, { recursive: true }) } catch { /* no shots this run */ }

// The Vite base defaults to '/' (WEBUI_BASE is only for subpath hosting), so the
// fakes' root-served statics match what a real container serves. This warning
// exists for the one way that can still go wrong: a dist built with a NON-ROOT
// base left on disk — dist is git-ignored, so `git pull` never refreshes it, and
// pi-web's bind-mounted copy ages the same way. Without the warning the symptom
// is a 15 s `.sidebar .item` timeout that reads exactly like a UI or fixture bug,
// and the two fakes that do strip `/webui/` would pass anyway (partial green).
// One line names the cause and the fix.
try {
  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8')
  if (/\b(?:src|href)="\/webui\//.test(html)) {
    console.warn(
      `\n[setup] ${DIST}/index.html requests /webui/* assets — this dist was built with a` +
        ` non-root Vite base (stale, or WEBUI_BASE=/webui/). Rebuild it: cd webui && npm run build\n`
    )
  }
} catch { /* no dist yet — the usual 'build first' failure follows */ }

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

  // Generate fonts.conf at runtime with absolute paths derived from WEBTEST_DIR.
  // The static fixtures/fonts.conf has a hardcoded sandbox path that breaks in CI.
  const fontsDir = path.join(WEBTEST_DIR, 'fixtures', 'fonts')
  const cacheDir = path.join(WEBTEST_DIR, 'fixtures', 'fontcache')
  if (fs.existsSync(fontsDir)) {
    const conf = [
      '<?xml version="1.0"?>',
      '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">',
      '<fontconfig>',
      `  <dir>${fontsDir}</dir>`,
      `  <cachedir>${cacheDir}</cachedir>`,
      '  <alias><family>sans-serif</family><prefer><family>Liberation Sans</family><family>DejaVu Sans</family></prefer></alias>',
      '  <alias><family>serif</family><prefer><family>Liberation Serif</family><family>DejaVu Serif</family></prefer></alias>',
      '  <alias><family>monospace</family><prefer><family>Liberation Mono</family><family>DejaVu Sans Mono</family></prefer></alias>',
      '</fontconfig>',
    ].join('\n')
    const generated = path.join(WEBTEST_DIR, 'fixtures', 'fonts.generated.conf')
    fs.writeFileSync(generated, conf)
    process.env.FONTCONFIG_FILE = generated
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

// ---- shared timing helpers -------------------------------------------------

/** Promise-based sleep. */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll a predicate until it returns truthy or timeout expires.
 * Returns the final predicate result.
 */
export const poll = async (fn, timeout = 1500, iv = 100) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await fn()) return true;
    await sleep(iv);
  }
  return !!(await fn());
};

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
