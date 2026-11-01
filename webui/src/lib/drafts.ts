import { writable } from 'svelte/store'

// ---- unsent composer text -------------------------------------------------
// The set of OPEN tab ids whose compose box currently holds text. Two guards
// hang off it:
//   • App.closeTab() confirms before dropping that tab (its box dies with it —
//     tab text is per-component state, nothing persists it), and
//   • beforeunload hands reload / window-close to the browser's own "Leave
//     site?" prompt, because tabs persist to localStorage but drafts don't.
// Kept out of the Tab objects on purpose: patching a tab per keystroke would
// churn the tab bar's render on every character.
const w = writable<Set<string>>(new Set())
export const draftTabs = { subscribe: w.subscribe }

// synchronous mirror — command/close paths read it outside reactivity
let dirty = new Set<string>()

export function setDraftDirty(id: string, dirtyNow: boolean): void {
  if (!id) return
  if (dirtyNow === dirty.has(id)) return
  const next = new Set(dirty)
  if (dirtyNow) next.add(id)
  else next.delete(id)
  dirty = next
  w.set(next)
}

export function clearDraft(id: string): void {
  setDraftDirty(id, false)
}

export function hasDraft(id: string): boolean {
  return dirty.has(id)
}

export function draftCount(): number {
  return dirty.size
}

// Drop ids that are no longer open. Without this a `pending-*` tab realized
// into a real session (tabs.rekey → the pane's each-key changes, so its
// Composer is recreated and never reports the old id) would stay dirty and
// prompt for reloads forever.
export function pruneDrafts(openIds: Iterable<string>): void {
  const keep = new Set(openIds)
  let stale = false
  for (const id of dirty)
    if (!keep.has(id)) {
      stale = true
      break
    }
  if (!stale) return
  const next = new Set<string>()
  for (const id of dirty) if (keep.has(id)) next.add(id)
  dirty = next
  w.set(next)
}

// Chrome requires preventDefault AND returnValue; Safari only returnValue.
// A listener that never cancels is what keeps this harmless: browsers only
// honour the prompt once the page has had a user interaction (typing does that).
export function onBeforeUnload(e: BeforeUnloadEvent): void {
  if (!dirty.size) return
  e.preventDefault()
  e.returnValue = ''
}

export function installDraftGuard(target: Window = window): () => void {
  target.addEventListener('beforeunload', onBeforeUnload)
  return () => target.removeEventListener('beforeunload', onBeforeUnload)
}

// Native confirm, matching the app's other destructive-path prompts (alert()
// on open failure). The message names the tab so a background tab's draft is
// identifiable; the body stays the same for the untitled/pending case.
export function discardPrompt(title: string): string {
  const who = title ? `"${title}"` : 'this tab'
  return `Discard the unsent message in ${who}?\n\nThe message text will be lost — the conversation history stays on the server.`
}
