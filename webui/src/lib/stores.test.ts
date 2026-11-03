import { test } from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'svelte/store'
import { registerHooks } from 'node:module'

// stores.ts (like most of the webui's lib) imports its siblings extensionless
// ('./api') — Vite resolves that, Node's type stripping does not. The hook is
// registered BEFORE the dynamic import below; a static import would resolve
// before the hook body ever ran.
registerHooks({
  resolve(specifier: string, context: any, nextResolve: any) {
    try {
      return nextResolve(specifier, context)
    } catch (err) {
      if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context)
      }
      throw err
    }
  },
})
// Node has no localStorage; stores.ts tolerates that (try/catch everywhere),
// but the width persistence needs one BEFORE the import — the module reads it
// at init.
const mem = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
}
const {
  drawer,
  tabs,
  infoOpen,
  openDrawer,
  closeDrawer,
  toggleDrawer,
  toggleDrawerLast,
  toggleInfo,
  clampDrawerWidth,
  setDrawerWidth,
  saveDrawerWidth,
  storedDrawerWidth,
  metricsFromMessages,
} = await import('./stores.ts')

// The drawer and Info share the right edge (one at a time), so opening the
// drawer hides Info — but it must give the space BACK. The latch lives in
// stores.ts: `infoSuppressed` means "the drawer closed Info", not "Info was
// closed", and an explicit Info toggle clears it outright.
test('closing the drawer gives Info back when the drawer took it', () => {
  infoOpen.set(true)
  openDrawer('files')
  assert.equal(get(infoOpen), false, 'opening the drawer hides Info')
  closeDrawer()
  assert.equal(get(drawer).open, false)
  assert.equal(get(infoOpen), true, 'closing it gives Info back')
})

test('no Info is resurrected when none was showing', () => {
  infoOpen.set(false)
  toggleDrawerLast() // open
  assert.equal(get(drawer).open, true)
  toggleDrawerLast() // close
  assert.equal(get(infoOpen), false, 'it stays closed')
})

test('the latch survives a tab switch while the drawer is open', () => {
  infoOpen.set(true)
  openDrawer('files')
  toggleDrawer('changes') // stays open, changes tab
  assert.equal(get(drawer).tab, 'changes')
  assert.equal(get(drawer).open, true)
  closeDrawer()
  assert.equal(get(infoOpen), true, 'the tab switch must not consume the latch')
})

test('an explicit Info toggle supersedes the restore', () => {
  infoOpen.set(true)
  openDrawer('files') // suppresses, latch set
  toggleInfo() // user takes the space back by hand
  assert.equal(get(infoOpen), true)
  assert.equal(get(drawer).open, false, 'opening Info closes the drawer')
  toggleInfo() // and closes Info again by hand
  closeDrawer() // drawer already closed — nothing to give back
  assert.equal(get(infoOpen), false, 'no resurrection after an explicit close')
})

// ---- resizable drawer ------------------------------------------------------
// The clamp is the whole policy; the drag action is DOM glue around it. The
// 0.28 transcript floor is the SAME number fsbox-check asserts on the rendered
// layout (main.clientWidth >= viewport * 0.28) — the test pins that they have
// not drifted apart.
test('clampDrawerWidth holds the 340px floor and the transcript share', async () => {
  const { TRANSCRIPT_FLOOR } = await import('./stores.ts')
  assert.equal(TRANSCRIPT_FLOOR, 0.28, 'fsbox-check asserts exactly this floor on the rendered layout')

  // below the floor: 340 wins (matches .diffwrap's min-width)
  assert.equal(clampDrawerWidth(100, 1000, 1280), 340)
  // above the ceiling: the transcript keeps 28% of the viewport
  const max = clampDrawerWidth(10000, 1000, 1280)
  assert.equal(max, 1000 - Math.ceil(1280 * 0.28))
  assert.equal(1000 - max >= 1280 * 0.28, true, 'main keeps its share')
  // a sane value passes through untouched
  assert.equal(clampDrawerWidth(520, 1000, 1280), 520)
  // tiny window: the min wins over a ceiling that fell below it
  assert.equal(clampDrawerWidth(500, 400, 500), 340)
})

test('the drawer width survives a reload and garbage does not', () => {
  setDrawerWidth(520)
  saveDrawerWidth()
  assert.equal(storedDrawerWidth(), 520)
  mem.set('opencode.drawer.width', 'wide')
  assert.equal(storedDrawerWidth(), null, 'non-numeric is not a width')
  mem.set('opencode.drawer.width', '-20')
  assert.equal(storedDrawerWidth(), null, 'negative is not a width')
  mem.set('opencode.drawer.width', '0')
  assert.equal(storedDrawerWidth(), null, 'zero is not a width')
  // valid again, and it also feeds the live store
  setDrawerWidth(400)
  saveDrawerWidth()
  assert.equal(storedDrawerWidth(), 400)
})

// A re-open (sidebar row click, boot restore, openHistory → openLive chains)
// must never blank a loaded transcript: callers pass `messages: []` as
// "nothing known yet" and refill right after — but when the refill fails
// (engine blip, slow fetch) the tab used to stay EMPTY. See the
// reopen-clobber.test.mjs e2e regression for the full wiring.
test('re-opening a tab with an empty message list keeps the loaded transcript', () => {
  tabs.open({ id: 'ses_keep', title: 't', messages: [{ info: { id: 'm1' }, parts: [] }, { info: { id: 'm2' }, parts: [] }], live: true })
  tabs.open({ id: 'ses_keep', title: 't', messages: [], live: true })
  const t = get(tabs).find((x) => x.id === 'ses_keep')
  assert.deepEqual(
    t.messages.map((m: any) => m.info.id),
    ['m1', 'm2'],
    'the empty re-open list is a placeholder, not a snapshot',
  )
})

test('re-opening a tab with a real snapshot replaces the loaded window', () => {
  tabs.open({ id: 'ses_swap', title: 't', messages: [{ info: { id: 'm1' }, parts: [] }], live: true })
  tabs.open({ id: 'ses_swap', title: 't', messages: [{ info: { id: 'm9' }, parts: [] }], live: true })
  const t = get(tabs).find((x) => x.id === 'ses_swap')
  assert.deepEqual(t.messages.map((m: any) => m.info.id), ['m9'], 'a non-empty snapshot still wins')
})

// ---- the activity clock on the refetch path --------------------------------
// `sessionMetrics[sid].updated` had exactly ONE writer: a `session.updated` SSE
// frame. pi-web gates those frames on a projection signature that deliberately
// EXCLUDES time.updated, so a session whose turn ended without one (abort, a
// failed compaction, a dropped stream) kept its row timestamp pinned, and the
// transcript refetch — the one payload that always lands — had no clock to
// overwrite it with. metricsFromMessages must supply it.
test('metricsFromMessages carries the newest user/assistant stamp as updated', () => {
  const msgs = [
    { info: { id: 'u1', role: 'user', time: { created: 5_000 } } },
    { info: { id: 'a1', role: 'assistant', time: { created: 9_000 }, tokens: { output: 3 } } },
  ]
  assert.equal(metricsFromMessages(msgs, true).updated, 9_000)
})

test('metricsFromMessages ignores non-conversation roles for the clock', () => {
  const msgs = [
    { info: { id: 'a1', role: 'assistant', time: { created: 9_000 } } },
    { info: { id: 't1', role: 'tool', time: { created: 500_000 } } },
  ]
  assert.equal(metricsFromMessages(msgs, true).updated, 9_000)
})

test('a PARTIAL page emits no updated (it can only under-report the clock)', () => {
  const msgs = [{ info: { id: 'a1', role: 'assistant', time: { created: 9_000 } } }]
  assert.equal('updated' in metricsFromMessages(msgs, false), false)
  assert.equal('updated' in metricsFromMessages([], true), false)
})
