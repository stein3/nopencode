import { writable } from 'svelte/store'

// Focus mode: JS-fullscreen + keyboard lock so reserved chords (Ctrl+W,
// Ctrl+Shift+W) reach the page instead of the browser chrome.
// - Chromium: navigator.keyboard.lock(['KeyW']) captures W with any modifiers
// - Firefox 151+ / Safari 26.4+: requestFullscreen({ keyboardLock:'browser' });
//   engines without the option either reject (handled) or ignore it (graceful:
//   plain fullscreen, no capture). Page must preventDefault() itself — the
//   existing hotkeys.ts Ctrl+W branch already does.
export const focusMode = writable<{ available: boolean; on: boolean }>({
  available: false,
  on: false,
})

let installed = false

export function initKbdLock(): () => void {
  if (!installed) {
    installed = true
    focusMode.update((s) => ({ ...s, available: kbdLockAvailable() }))
    document.addEventListener('fullscreenchange', syncOnExit)
  }
  return () => document.removeEventListener('fullscreenchange', syncOnExit)
}

function kbdLockAvailable(): boolean {
  const kb = (navigator as any).keyboard
  if (kb && typeof kb.lock === 'function') return true // Chromium path
  return typeof document.fullscreenEnabled === 'boolean' && document.fullscreenEnabled
}

function syncOnExit() {
  // lock auto-releases when fullscreen exits (Esc-hold, tab switch) — track reality
  if (!document.fullscreenElement) focusMode.update((s) => (s.on ? { ...s, on: false } : s))
}

export async function enableFocusMode(): Promise<void> {
  try {
    await document.documentElement.requestFullscreen({ keyboardLock: 'browser' } as any)
  } catch {
    await document.documentElement.requestFullscreen()
  }
  const kb = (navigator as any).keyboard
  if (kb && typeof kb.lock === 'function') {
    try {
      await kb.lock(['KeyW'])
    } catch {
      /* permission denied etc. — fullscreen alone is still useful */
    }
  }
  focusMode.set({ available: true, on: true })
}

export async function disableFocusMode(): Promise<void> {
  const kb = (navigator as any).keyboard
  if (kb && typeof kb.unlock === 'function') {
    try {
      kb.unlock()
    } catch {}
  }
  if (document.fullscreenElement) {
    try {
      await document.exitFullscreen()
    } catch {}
  }
  focusMode.set({ available: true, on: false })
}
