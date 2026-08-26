import { writable, get } from 'svelte/store'
import { tabs, selectedModel, sessionAgent } from './stores'
import { oc } from './api'

// Auto-retry for retryable turn failures. The engine stamps isRetryable on
// transient provider errors (APIError class, e.g. upstream 5xx — verified in
// opencode.db: {"name":"APIError","data":{...,"isRetryable":true}}). When the
// SSE session.error carries that flag, the failed turn's user message is
// re-dispatched with a growing (not quite exponential) backoff:
//   1s → 2s → 3s → 5s → 15s → 30s → 60s → 2m → 5m, then every 5m until
// the turn lands.
// Manual sends and tab closes cancel the loop; a clean turn (session.idle
// with no error since the last dispatch) resets it.
//
// Countdown is a 1s ticker, so background-tab timer throttling can stretch
// delays — harmless: the retry just fires later, and the UI isn't visible
// in a hidden tab anyway.

const DELAYS = [1, 2, 3, 5, 15, 30, 60, 120, 300] // seconds; index min(attempt-1, last)

export interface RetryState {
  attempt: number // dispatch number (1 = first retry after the original failure)
  secondsLeft: number // countdown; 0 while a dispatch is in flight
}

// sid → pending/last retry, consumed by the transcript retry line
export const retryState = writable<Record<string, RetryState>>({})

// error-vs-dispatch ordering per session: a clean idle (nothing failed since
// the last dispatch) clears the loop; an idle that trails an error must NOT
// (engines may emit idle after session.error — clearing there would kill the
// pending retry)
const lastErrorAt = new Map<string, number>()
const lastDispatchAt = new Map<string, number>()

let ticker: ReturnType<typeof setInterval> | undefined

export function isRetryableError(em: any): boolean {
  if (!em || em?.name === 'MessageAbortedError') return false
  return em?.data?.isRetryable === true || em?.isRetryable === true
}

function setState(sid: string, s: RetryState | undefined) {
  retryState.update((all) => {
    if (all[sid] === s || (all[sid] && s && all[sid].attempt === s.attempt && all[sid].secondsLeft === s.secondsLeft))
      return all
    const next = { ...all }
    if (s) next[sid] = s
    else delete next[sid]
    return next
  })
}

function ensureTicker() {
  if (ticker) return
  ticker = setInterval(() => {
    const due: string[] = []
    retryState.update((all) => {
      const next: Record<string, RetryState> = {}
      for (const [sid, s] of Object.entries(all)) {
        if (s.secondsLeft > 1) {
          next[sid] = { ...s, secondsLeft: s.secondsLeft - 1 }
        } else if (s.secondsLeft === 1) {
          next[sid] = { ...s, secondsLeft: 0 }
          due.push(sid)
        } else {
          next[sid] = s // dispatch already in flight
        }
      }
      return next
    })
    for (const sid of due) fire(sid)
    if (!due.length && !Object.values(get(retryState)).some((s) => s.secondsLeft > 0)) {
      clearInterval(ticker)
      ticker = undefined
    }
  }, 1000)
}

export function scheduleRetry(sid: string) {
  lastErrorAt.set(sid, Date.now())
  const cur = get(retryState)[sid]
  if (cur && cur.secondsLeft > 0) return // countdown already running (duplicate event)
  const attempt = (cur?.attempt ?? 0) + 1
  const delay = DELAYS[Math.min(attempt - 1, DELAYS.length - 1)]
  setState(sid, { attempt, secondsLeft: delay })
  ensureTicker()
}

// The failed turn's prompt = the newest user message's text parts.
function lastUserText(sid: string): string | null {
  const t = tabs.snapshot(sid)
  if (!t) return null
  for (let i = t.messages.length - 1; i >= 0; i--) {
    const m = t.messages[i]
    if (m.role !== 'user') continue
    const text = (m.parts ?? [])
      .filter((p: any) => p.type === 'text' && (p.text ?? '').trim())
      .map((p: any) => p.text ?? '')
      .join('\n\n')
      .trim()
    return text || null
  }
  return null
}

function fire(sid: string) {
  if (!tabs.isopen(sid)) {
    clearRetry(sid)
    return
  }
  const text = lastUserText(sid)
  if (!text) {
    clearRetry(sid)
    return
  }
  lastDispatchAt.set(sid, Date.now())
  tabs.patch(sid, { busy: true }) // spinner while the retried turn runs
  // same prefs as a manual send (picker model + that session's agent pick) so
  // a retried turn doesn't silently fall back to the session default agent
  oc.prompt(sid, text, get(selectedModel) ?? undefined, sessionAgent(sid)).catch(() => {
    // dispatch itself died (network/proxy) — counts as another failure
    tabs.patch(sid, { busy: false })
    scheduleRetry(sid)
  })
}

export function clearRetry(sid: string) {
  lastErrorAt.delete(sid)
  lastDispatchAt.delete(sid)
  setState(sid, undefined)
}

// Manual send takes over — the user is driving now.
export const cancelRetry = clearRetry

// session.idle handler: only a turn that finished WITHOUT a fresh error ends
// the loop (see ordering note above).
export function onTurnIdle(sid: string) {
  const e = lastErrorAt.get(sid)
  const d = lastDispatchAt.get(sid)
  if (d !== undefined && d >= (e ?? 0)) clearRetry(sid)
}
