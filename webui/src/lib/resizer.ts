import { get } from 'svelte/store'
import { clampDrawerWidth, setDrawerWidth, saveDrawerWidth, drawerWidth } from './stores'

/**
 * Drag handle for the drawer's width. All the policy (340px floor, transcript's
 * 28% share) lives in clampDrawerWidth and is unit-tested; this file is DOM
 * glue around it: pointer capture, measuring what the drawer and the transcript
 * actually split, and persisting on release.
 *
 * `node` is the grip, a direct child of the drawer (`.diffwrap`).
 */
export function dragWidth(node: HTMLElement) {
  const wrap = node.parentElement
  if (!wrap) return {}

  let startX = 0
  let startW = 0
  let shared = 0 // what drawer + transcript split — measured, never assumed
  let dragging = false

  function measure() {
    const main = wrap!.parentElement?.querySelector('main')
    shared = wrap!.clientWidth + (main?.clientWidth ?? 0)
  }
  function apply(px: number) {
    setDrawerWidth(clampDrawerWidth(px, shared, window.innerWidth))
  }

  // Clamp once on mount and again on window resize: a width stored on a bigger
  // screen (or with the sidebar closed) must not hold the transcript under its
  // floor just because nothing was dragged since.
  function reclamp() {
    const w = get(drawerWidth)
    if (w == null) return
    measure()
    apply(w)
  }
  reclamp()

  function onDown(e: PointerEvent) {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    dragging = true
    startX = e.clientX
    startW = wrap!.clientWidth
    measure()
    node.setPointerCapture(e.pointerId)
    e.preventDefault() // no text selection while dragging
  }
  function onMove(e: PointerEvent) {
    if (!dragging) return
    // the grip is on the drawer's LEFT edge: dragging left (smaller x) widens
    apply(startW + (startX - e.clientX))
  }
  function onUp(e: PointerEvent) {
    if (!dragging) return
    dragging = false
    saveDrawerWidth()
    try {
      node.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
  }

  // The drawer itself listens for touch swipes (sidePanel: swipe to close) and
  // the window has edge-swipe handlers — a resize drag is a horizontal touch
  // move and would read as "close the drawer" mid-drag. The grip swallows the
  // touch stream; its own drag rides pointer events, which are a separate
  // stream and keep working.
  function swallow(e: Event) {
    e.stopPropagation()
  }

  node.addEventListener('pointerdown', onDown)
  node.addEventListener('pointermove', onMove)
  node.addEventListener('pointerup', onUp)
  node.addEventListener('pointercancel', onUp)
  node.addEventListener('touchstart', swallow, { passive: true })
  node.addEventListener('touchmove', swallow, { passive: true })
  window.addEventListener('resize', reclamp)

  return {
    destroy() {
      node.removeEventListener('pointerdown', onDown)
      node.removeEventListener('pointermove', onMove)
      node.removeEventListener('pointerup', onUp)
      node.removeEventListener('pointercancel', onUp)
      node.removeEventListener('touchstart', swallow)
      node.removeEventListener('touchmove', swallow)
      window.removeEventListener('resize', reclamp)
    },
  }
}
