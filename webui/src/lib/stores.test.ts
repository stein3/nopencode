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
const { drawer, infoOpen, openDrawer, closeDrawer, toggleDrawer, toggleDrawerLast, toggleInfo } =
  await import('./stores.ts')

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
