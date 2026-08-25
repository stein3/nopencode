// Soft-keyboard fix for browsers whose keyboard OVERLAYS the layout instead
// of shrinking it (iOS Safari, Chrome Android <108, Samsung Internet <21).
// The shell keeps its 100vh/100dvh height while only the *visual* viewport
// shrinks/pans, so the bottom-docked composer sits under the keyboard with
// zero page overflow to scroll. We mirror the visible height into --vvh;
// CSS consumes it via `@supports (height:100dvh){ height:var(--vvh,100dvh) }`.
//
// Both resize AND scroll matter: the keyboard can pan the visual viewport
// (offsetTop > 0) without changing its height, and those pans arrive as
// scroll events. innerHeight - vv.height - vv.offsetTop approximates the
// covered (keyboard) height. At <=1px the keyboard counts as closed — or the
// browser already resized the layout itself (the interactive-widget=
// resizes-content path) — and --vvh is REMOVED so pure 100dvh CSS rules
// again; the reset is threshold-free, no hysteresis to get stuck in.
// Pinch-zoom (scale != 1) changes vv.height for unrelated reasons: ignore.

let installed = false

export function installVisualViewportFix(): void {
  const vv = window.visualViewport
  if (!vv || installed) return // undefined support guard + HMR double-mount guard
  installed = true

  let raf = 0
  const apply = () => {
    raf = 0
    if (Math.abs(vv.scale - 1) > 0.01) return // pinch-zoom: not the keyboard
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
    if (kb <= 1) document.documentElement.style.removeProperty('--vvh')
    else document.documentElement.style.setProperty('--vvh', `${vv.height}px`)
  }
  const queue = () => {
    if (!raf) raf = requestAnimationFrame(apply) // coalesce event bursts to one frame
  }

  vv.addEventListener('resize', queue, { passive: true })
  vv.addEventListener('scroll', queue, { passive: true })
  queue()
}
