import { writable, get } from 'svelte/store'
import { tabs, selectedModel, sessionAgent, autoRetry, retryMaxAttempts, retryMaxDelay } from './stores'
import { oc } from './api'

// Auto-retry for retryable turn failures. The engine stamps isRetryable on
// transient provider errors (APIError class, e.g. upstream 5xx — verified in
// opencode.db: {"name":"APIError","data":{...,"isRetryable":true}}). When the
// SSE session.error carries that flag, the loop re-dispatches with a growing
// (not quite exponential) backoff:
//   1s → 2s → 3s → 5s → 15s → 30s → 60s → 2m → 5m, then every 5m until
// the turn lands.
//
// Nudge vs resend: arming happens ONLY from a witnessed session.error
// (isRetryable), and that event proves the engine accepted the original
// prompt_async — the turn ran, then the provider died mid-turn. Re-posting
// the original text would duplicate it in history on every attempt, so once
// delivery is proven each fire() sends the short STALL_NUDGE instead. The
// verbatim-resend branch exists only for undelivered dispatches: if the
// synced transcript's newest user message equals what we last tried to land,
// that attempt DID arrive (→ switch to the nudge); otherwise keep resending
// the payload that never made it.
//
// Manual sends and tab closes cancel the loop; a clean turn (session.idle
// with no error since the last dispatch) resets it.
//
// Countdown is a 1s ticker, so background-tab timer throttling can stretch
// delays — harmless: the retry just fires later, and the UI isn't visible
// in a hidden tab anyway.

const DELAYS = [1, 2, 3, 5, 15, 30, 60, 120, 300] // seconds; index min(attempt-1, last)

const STALL_NUDGE = 'the session stalled, continue.'

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

// Per-session retry payload state: what the loop is trying to land and
// whether the original prompt was confirmed delivered to the engine.
interface LoopState {
  orig: string // newest user msg text captured at arm time ('' if none)
  attempted: string // what we're currently trying to land
  delivered: boolean // original prompt confirmed received by engine
}
const loops = new Map<string, LoopState>()

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
  // timing/backoff only — does NOT create loop state; arming is
  // onRetryableError's job (a bare scheduleRetry never dispatches)
  if (!get(autoRetry)) return
  lastErrorAt.set(sid, Date.now())
  const cur = get(retryState)[sid]
  if (cur && cur.secondsLeft > 0) return // countdown already running (duplicate event)
  const attempt = (cur?.attempt ?? 0) + 1
  const maxAttempts = get(retryMaxAttempts)
  if (maxAttempts > 0 && attempt > maxAttempts) {
    clearRetry(sid)
    return
  }
  const delayIdx = Math.min(attempt - 1, DELAYS.length - 1)
  const delay = Math.min(DELAYS[delayIdx], get(retryMaxDelay))
  setState(sid, { attempt, secondsLeft: delay })
  ensureTicker()
}

// Entry point from sse.ts's session.error(isRetryable) handler: arms the loop
// on the first witnessed error for this session, then schedules the retry.
// Witnessing the error proves the engine accepted the original prompt_async
// (the turn ran before the provider failed) → delivered=true, so every fire()
// nudges instead of duplicating the original prompt.
export function onRetryableError(sid: string) {
  if (!get(autoRetry)) return
  const cur = loops.get(sid)
  if (!cur) {
    loops.set(sid, { orig: lastUserText(sid) ?? '', attempted: '', delivered: true })
  }
  scheduleRetry(sid)
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
  if (!tabs.isopen(sid) || !get(autoRetry)) {
    clearRetry(sid)
    return
  }
  const lp = loops.get(sid)
  if (!lp) {
    clearRetry(sid) // never armed via onRetryableError — nothing to send
    return
  }
  let text: string | null
  if (lp.delivered) {
    // original prompt reached the engine (witnessed turn failure) — a verbatim
    // resend would duplicate it in history; nudge the stalled turn instead
    text = STALL_NUDGE
  } else {
    // Undelivered dispatch: did our last attempt actually land? If the synced
    // transcript's newest user message equals it, it did → switch to nudge.
    const newest = lastUserText(sid)
    if (newest && newest === lp.attempted) {
      lp.delivered = true
      text = STALL_NUDGE
    } else {
      text = lp.attempted || lp.orig || newest // never landed → resend it
    }
  }
  if (!text || !text.trim()) {
    clearRetry(sid)
    return
  }
  lp.attempted = text
  lastDispatchAt.set(sid, Date.now())
  tabs.patch(sid, { busy: true }) // spinner while the retried turn runs
  // same prefs as a manual send (picker model + that session's agent pick) so
  // a retried turn doesn't silently fall back to the session default agent
  oc.prompt(sid, text, get(selectedModel) ?? undefined, sessionAgent(sid)).catch(() => {
    // dispatch itself died (network/proxy) — counts as another failure.
    // delivered flag persists → a dead nudge re-nudges, an undelivered
    // resend re-checks against the transcript on the next fire
    tabs.patch(sid, { busy: false })
    scheduleRetry(sid)
  })
}

export function clearRetry(sid: string) {
  lastErrorAt.delete(sid)
  lastDispatchAt.delete(sid)
  loops.delete(sid)
  setState(sid, undefined)
}

// What the pending countdown will send when it fires ('nudge' = short stall
// message because the original prompt was already delivered, 'resend' =
// verbatim payload) — consumed by the transcript retryline.
export function nextPayloadKind(sid: string): 'nudge' | 'resend' {
  return (loops.get(sid)?.delivered ?? true) ? 'nudge' : 'resend'
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
