export interface HotkeyHandlers {
  focusSearch: () => void
  focusComposer: () => void
  newChat: () => void
  closeTab: () => void
  cycleTabs: (dir: 1 | -1) => void
  jumpTab: (n: number) => void
  openPalette?: () => void
}

function typing(el: EventTarget | null): boolean {
  return (
    el instanceof HTMLElement &&
    (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
  )
}

export function initHotkeys(h: HotkeyHandlers) {
  const onKey = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey
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
    } else if (e.altKey && e.key === 'ArrowRight') {
      e.preventDefault()
      h.cycleTabs(1)
    } else if (e.altKey && e.key === 'ArrowLeft') {
      e.preventDefault()
      h.cycleTabs(-1)
    } else if (e.altKey && /^[1-9]$/.test(e.key)) {
      e.preventDefault()
      h.jumpTab(Number(e.key))
    } else if (e.key === '/' && !typing(e.target)) {
      e.preventDefault()
      h.focusComposer()
    }
  }
  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
}
