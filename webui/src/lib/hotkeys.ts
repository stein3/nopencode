import { chordPending } from './stores'

export interface HotkeyHandlers {
  focusSearch: () => void
  focusComposer: () => void
  newChat: () => void
  closeTab: () => void
  cycleTabs: (dir: 1 | -1) => void
  jumpTab: (n: number) => void
  navSession?: (dir: 1 | -1) => void
  toggleDiff?: () => void
  openPalette?: () => void
  // ctrl+x leader chords (TUI parity): plain key → action, resolved while a
  // chord is armed. Keys without an entry disarm silently.
  chords?: Record<string, () => void>
}

// which-key strip labels, in display order (WhichKey.svelte renders these)
export const CHORD_HINTS: Record<string, string> = {
  n: 'new',
  l: 'sessions',
  b: 'sidebar',
  m: 'models',
  a: 'agents',
  g: 'timeline',
  c: 'compact',
  x: 'export',
  y: 'copy last',
  u: 'undo',
  s: 'status',
}

const CHORD_TIMEOUT_MS = 2000

function typing(el: EventTarget | null): boolean {
  return (
    el instanceof HTMLElement &&
    (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
  )
}

export function initHotkeys(h: HotkeyHandlers) {
  let armed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  function disarm() {
    armed = false
    clearTimeout(timer)
    chordPending.set(false)
  }

  function arm() {
    // arming while already armed re-arms (restarts the window)
    armed = true
    clearTimeout(timer)
    chordPending.set(true)
    timer = setTimeout(disarm, CHORD_TIMEOUT_MS)
  }

  const onKey = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey

    // ---- ctrl+x leader chords -------------------------------------------
    // While armed, chord resolution takes precedence over everything below.
    if (armed) {
      if (typing(e.target)) {
        // focus moved into an input while armed — stand down, never hijack typing
        disarm()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        disarm()
        return
      } else if (!mod && !e.altKey && !e.shiftKey) {
        const k = e.key.toLowerCase()
        e.preventDefault() // mapped or not, a plain key while armed is consumed
        disarm()
        h.chords?.[k]?.()
        return
      } else {
        // any modifier combo passes through untouched (no preventDefault) and
        // just disarms — ctrl+t etc. keep working mid-chord via the chain below
        disarm()
      }
    }

    // ---- direct bindings --------------------------------------------------
    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      h.focusSearch()
    } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'p') {
      // must precede any browser default (print dialog)
      e.preventDefault()
      h.openPalette?.()
    } else if (mod && e.key.toLowerCase() === 't') {
      e.preventDefault()
      h.newChat()
    } else if (mod && e.key.toLowerCase() === 'w') {
      e.preventDefault()
      h.closeTab()
    } else if (e.altKey && !mod && e.code === 'KeyW') {
      // cross-browser fallback: Ctrl+W is browser-reserved in normal tabs
      e.preventDefault()
      h.closeTab()
    } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'd') {
      // diff pane toggle
      e.preventDefault()
      h.toggleDiff?.()
    } else if (mod && e.key === '/') {
      // works even while typing (e.g. escape hatch out of the search box)
      e.preventDefault()
      h.focusComposer()
    } else if (e.altKey && e.key === 'ArrowRight') {
      e.preventDefault()
      h.cycleTabs(1)
    } else if (e.altKey && e.key === 'ArrowLeft') {
      e.preventDefault()
      h.cycleTabs(-1)
    } else if (e.altKey && /^[1-9]$/.test(e.key)) {
      e.preventDefault()
      h.jumpTab(Number(e.key))
    } else if (e.altKey && e.key === 'ArrowUp') {
      e.preventDefault()
      h.navSession?.(-1)
    } else if (e.altKey && e.key === 'ArrowDown') {
      e.preventDefault()
      h.navSession?.(1)
    } else if (e.key === '/' && !typing(e.target)) {
      e.preventDefault()
      h.focusComposer()
    } else if (!armed && !typing(e.target) && mod && !e.shiftKey && e.key.toLowerCase() === 'x') {
      // arm the ctrl+x leader LAST so direct bindings keep priority when not
      // armed; preventDefault keeps the browser's cut() out of the way.
      // While typing in an input this branch never fires → browser cut works.
      arm()
    }
  }
  window.addEventListener('keydown', onKey)
  return () => {
    window.removeEventListener('keydown', onKey)
    disarm()
  }
}
