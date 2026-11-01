// Unit tests for the unsent-draft guard (src/lib/drafts.ts): which tabs count
// as holding unsent text, how that set survives a pending→real rekey, and what
// the beforeunload handler does with it. Pure module — no DOM, no stores.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  draftTabs as draftTabsStore,
  setDraftDirty,
  clearDraft,
  hasDraft,
  draftCount,
  pruneDrafts,
  onBeforeUnload,
  installDraftGuard,
  discardPrompt,
} from './drafts.ts'

// A fake BeforeUnloadEvent: the real one is a DOM event, the handler only
// touches preventDefault() and returnValue.
function fakeUnload() {
  const ev: any = { defaultPrevented: false, returnValue: undefined }
  ev.preventDefault = () => (ev.defaultPrevented = true)
  return ev
}

test('empty and whitespace-only boxes are not drafts', () => {
  clearDraft('s1')
  setDraftDirty('s1', false)
  assert.equal(hasDraft('s1'), false)
  setDraftDirty('s1', !!'   \n\t '.trim())
  assert.equal(hasDraft('s1'), false)
  setDraftDirty('s1', !!'hi'.trim())
  assert.equal(hasDraft('s1'), true)
})

test('an id is only tracked once, and clearing is idempotent', () => {
  clearDraft('s2')
  setDraftDirty('s2', true)
  setDraftDirty('s2', true)
  assert.equal(hasDraft('s2'), true)
  clearDraft('s2')
  clearDraft('s2')
  assert.equal(hasDraft('s2'), false)
})

test('drafts are per tab', () => {
  pruneDrafts([]) // shared module state: start from a clean slate
  clearDraft('a')
  clearDraft('b')
  setDraftDirty('a', true)
  assert.deepEqual([...draftTabsList()], ['a'])
  setDraftDirty('b', true)
  assert.equal(draftCount(), 2)
  setDraftDirty('a', false)
  assert.equal(hasDraft('b'), true)
  clearDraft('a')
  clearDraft('b')
})

// helper mirroring the store contract without importing svelte/store types here
function draftTabsList(): string[] {
  let ids: string[] = []
  const un = draftTabsStore.subscribe((s) => (ids = [...s]))
  un()
  return ids
}

test('pruneDrafts drops ids no longer open (pending tab closed / rekeyed)', () => {
  setDraftDirty('pending-x', true)
  assert.equal(hasDraft('pending-x'), true)
  // realizeSession swaps the pending tab for the real session id: the store
  // must not keep a dirty ghost that prompts forever
  pruneDrafts(['ses_real', 'ses_other'])
  assert.equal(hasDraft('pending-x'), false)
})

test('pruneDrafts keeps the drafts of tabs that are still open', () => {
  setDraftDirty('ses_keep', true)
  pruneDrafts(['ses_keep'])
  assert.equal(hasDraft('ses_keep'), true)
  clearDraft('ses_keep')
})

test('beforeunload does nothing while no tab holds a draft', () => {
  pruneDrafts([])
  const ev = fakeUnload()
  onBeforeUnload(ev)
  assert.equal(ev.defaultPrevented, false)
  assert.equal(ev.returnValue, undefined)
})

test('beforeunload blocks when any open tab holds unsent text', () => {
  setDraftDirty('ses_one', true)
  const ev = fakeUnload()
  onBeforeUnload(ev)
  assert.equal(ev.defaultPrevented, true)
  assert.equal(ev.returnValue, '') // Chrome needs both, Safari only returnValue
  clearDraft('ses_one')
})

test('installDraftGuard registers and unregisters the listener', () => {
  const added: string[] = []
  const removed: string[] = []
  const target: any = {
    addEventListener: (t: string) => added.push(t),
    removeEventListener: (t: string) => removed.push(t),
  }
  const un = installDraftGuard(target)
  assert.deepEqual(added, ['beforeunload'])
  un()
  assert.deepEqual(removed, ['beforeunload'])
})

test('the close-tab prompt names the tab so the user knows which box', () => {
  const msg = discardPrompt('Refactor the parser')
  assert.match(msg, /Refactor the parser/)
  assert.match(discardPrompt(''), /unsent message/i)
})
