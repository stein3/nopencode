import type { Action } from 'svelte/action'

// Shared swipe-to-close gesture for the webui side drawers. Each drawer's root
// element applies `use:sidePanel={{ side, getOpen, setOpen }}` so the
// close logic lives in exactly one place (the original window-level handler in
// App.svelte only knew about `.sidebar` and `aside.info`, so the newer MCP and
// Diff panes couldn't be swiped closed).
export const SWIPE_EDGE = 80
export const SWIPE_DIST = 46

export interface SidePanelParams {
  side: 'left' | 'right'
  getOpen: () => boolean
  setOpen: (v: boolean) => void
  edge?: number
  dist?: number
}

function inHorizScroller(el: Element | null): boolean {
  let n = el as HTMLElement | null
  while (n && n !== document.body) {
    if (n.scrollWidth > n.clientWidth + 1 && /(auto|scroll)/.test(getComputedStyle(n).overflowX))
      return true
    n = n.parentElement
  }
  return false
}

export const sidePanel: Action<HTMLElement, SidePanelParams> = (node, params) => {
  let p = params
  let touch: number | null = null
  let startX = 0
  let startY = 0

  function start(e: TouchEvent) {
    if (touch !== null) return // one gesture at a time
    if (!window.matchMedia('(max-width: 900px)').matches) return
    if (!p.getOpen()) return // only the close gesture lives here; opening is
    // handled at the window level (App.svelte) so it works before mount
    const t = e.changedTouches[0]
    const el = t.target as Element | null
    // never hijack drags that belong to form controls, editable text, or
    // horizontally-scrollable blocks (e.g. code / the monaco diff editor)
    if (
      el?.closest?.('input, textarea, select') ||
      (el as HTMLElement | null)?.isContentEditable ||
      inHorizScroller(el)
    )
      return
    touch = t.identifier
    startX = t.clientX
    startY = t.clientY
  }

  function move(e: TouchEvent) {
    if (touch === null) return
    const t = Array.from(e.changedTouches).find((x) => x.identifier === touch)
    if (!t) return
    const dx = t.clientX - startX
    const dy = t.clientY - startY
    // commit once the drag is clearly horizontal and long enough
    if (Math.abs(dx) < (p.dist ?? SWIPE_DIST) || Math.abs(dx) < Math.abs(dy) * 1.4) return
    touch = null // consumed — one gesture, at most one action
    // push the drawer away from its anchored edge
    if (p.side === 'left' && dx < 0) p.setOpen(false)
    else if (p.side === 'right' && dx > 0) p.setOpen(false)
  }

  function end(e: TouchEvent) {
    if (touch !== null && Array.from(e.changedTouches).some((x) => x.identifier === touch))
      touch = null
  }

  node.addEventListener('touchstart', start, { passive: true })
  node.addEventListener('touchmove', move, { passive: true })
  node.addEventListener('touchend', end)
  node.addEventListener('touchcancel', end)

  return {
    update(next: SidePanelParams) {
      p = next
    },
    destroy() {
      node.removeEventListener('touchstart', start)
      node.removeEventListener('touchmove', move)
      node.removeEventListener('touchend', end)
      node.removeEventListener('touchcancel', end)
    },
  }
}
