import { writable } from 'svelte/store'
import type { OcMessage } from './api'
import { msgModel } from './util'

// Engine reverts don't delete messages — they mark a revert point on the
// session and the next prompt physically prunes. Until then every client must
// truncate its own view at this boundary.
export interface RevertPoint {
  messageID?: string
  partID?: string
}

export interface Tab {
  id: string // session id — or a local `pending-*` id until first send
  title: string
  messages: OcMessage[] // loaded window, chronological — NOT necessarily the whole session
  live: boolean // engine-backed vs pure history snapshot
  busy?: boolean
  dirty?: boolean // refetch pending
  // turn-failure tiles (SSE session.error). Persisted server-side by
  // chatserver (sidecar webui.db) so they survive reloads; cleared on the
  // next prompt dispatch.
  errors?: { message: string; t: number }[]
  errorsFetched?: boolean // persisted errors loaded for this tab (once per open)
  revert?: RevertPoint | null
  pending?: boolean // not created on the engine yet
  partial?: boolean // older messages exist on the engine but aren't loaded yet
  loadingOlder?: boolean // backfill fetch in flight (transcript shows a spinner)
  jumpTo?: string // message id the transcript should scroll to once rendered
  // draft text handed to the composer of a not-yet-mounted pane (fork-refill:
  // the forked-from message's text lands editable in the new tab's box)
  prefill?: string
}

function makeTabs() {
  const { subscribe, update, set } = writable<Tab[]>([])
  const { subscribe: subActive, set: setActiveStore } = writable('')
  const openIds = new Set<string>()
  let activeId = ''

  return {
    subscribe,
    active: { subscribe: subActive },
    isopen(id: string) {
      return openIds.has(id)
    },
    open(t: Tab, activate = true) {
      openIds.add(t.id)
      update((tabs) => {
        if (!tabs.find((x) => x.id === t.id)) tabs = [...tabs, t]
        return tabs
      })
      if (activate) {
        activeId = t.id
        setActiveStore(t.id)
      }
    },
    close(id: string) {
      openIds.delete(id)
      update((tabs) => {
        const i = tabs.findIndex((x) => x.id === id)
        const next = tabs.filter((x) => x.id !== id)
        if (activeId === id) {
          activeId = next[Math.min(i, next.length - 1)]?.id ?? ''
          setActiveStore(activeId)
        }
        return next
      })
    },
    patch(id: string, p: Partial<Tab>) {
      update((tabs) => tabs.map((t) => (t.id === id ? { ...t, ...p } : t)))
    },
    // swap a placeholder tab for the real session, preserving position
    rekey(oldId: string, next: Tab) {
      openIds.delete(oldId)
      openIds.add(next.id)
      update((all) => all.map((t) => (t.id === oldId ? next : t)))
      if (activeId === oldId) {
        activeId = next.id
        setActiveStore(next.id)
      }
    },
    // synchronous read of one tab (for command handlers outside reactivity)
    snapshot(id: string): Tab | undefined {
      let found: Tab | undefined
      subscribe((all) => (found = all.find((t) => t.id === id)))()
      return found
    },
    // Insert-or-update one part in place — the engine sends full snapshots,
    // so this gives us true streaming without a full refetch per token burst.
    upsertPart(sid: string, mid: string, part: any) {
      update((all) =>
        all.map((t) => {
          if (t.id !== sid) return t
          const existing = t.messages.find((x) => x.id === mid)
          const base =
            existing ??
            { id: mid, role: 'assistant', time: { created: Date.now() }, parts: [] }
          const others = t.messages.filter((x) => x.id !== mid)
          const parts = [...(base.parts ?? [])]
          const i = parts.findIndex((p) => p.id === part.id)
          if (i >= 0) parts[i] = { ...parts[i], ...part }
          else parts.push(part)
          const updated = { ...base, parts }
          return { ...t, messages: [...others, updated] }
        }),
      )
    },

    // Apply one incremental delta from message.part.delta events.
    appendDelta(sid: string, mid: string, pid: string, field: string, delta: string) {
      update((all) =>
        all.map((t) => {
          if (t.id !== sid) return t
          const m = t.messages.find((x) => x.id === mid)
          if (!m) return t // unknown yet; snapshot/refetch will materialize it
          const parts = (m.parts ?? []).map((p) => {
            if (p.id !== pid) return p
            if (field === 'text' || field === undefined)
              return { ...p, text: (p.text ?? '') + delta }
            if (field === 'metadata' && p.type === 'tool') return p // ignore for now
            return p
          })
          return { ...t, messages: t.messages.map((x) => (x === m ? { ...m, parts } : x)) }
        }),
      )
    },

    // Correct role/metadata once message.updated delivers the authoritative info
    setMeta(sid: string, info: any) {
      if (!info?.id) return
      // assistant info carries flat modelID/providerID, user info nests them
      // under `model` — msgModel reads both so user rows keep their badge
      const mm = msgModel(info)
      update((all) =>
        all.map((t) => {
          if (t.id !== sid) return t
          const exists = t.messages.some((x) => x.id === info.id)
          if (!exists) return t
          return {
            ...t,
            messages: t.messages.map((x) =>
              x.id === info.id
                ? { ...x, role: info.role ?? x.role, agent: info.agent ?? x.agent, modelID: mm.modelID ?? x.modelID, providerID: mm.providerID ?? x.providerID, time: info.time ?? x.time, error: info.error ?? x.error }
                : x,
            ),
          }
        }),
      )
    },
    setActive(id: string) {
      activeId = id
      setActiveStore(id)
    },
    getActive(): string {
      return activeId
    },
  }
}

export const tabs = makeTabs()

// ---- live per-session metrics (keeps the sidebar fresh for open tabs) ----
// The sidebar's sqlite snapshot only changes on reload; these values are
// maintained from SSE events and message fetches so open sessions show
// current tokens/cost/activity without a manual refresh.
export interface SessionMetrics {
  tokens?: number // context estimate: input+output+reasoning+cache of newest assistant message
  cost?: number // engine-maintained session spend
  updated?: number // last activity, ms epoch
  messages?: number // message count from the live engine view
}

export const sessionMetrics = writable<Record<string, SessionMetrics>>({})

export function patchMetrics(sid: string, m: SessionMetrics) {
  if (!sid || sid.startsWith('pending-')) return
  sessionMetrics.update((all) => ({ ...all, [sid]: { ...all[sid], ...m } }))
}

// Sum an engine token object into a context-size estimate. Returns undefined
// when nothing is counted: aborted, empty-step, and provider-silent turns
// permanently leave an ALL-ZERO `tokens` object on the newest assistant
// message — treating that as "0 context" made sessions display "--" / 0%
// forever. Callers fall back to the newest message that actually reported.
export function tokenTally(t?: Record<string, any> | null): number | undefined {
  if (!t) return undefined
  const n =
    (t.input ?? 0) +
    (t.output ?? 0) +
    (t.reasoning ?? 0) +
    ((t.cache?.read ?? 0) + (t.cache?.write ?? 0))
  return n > 0 ? n : undefined
}

// Derive metrics from a raw engine messages payload (info-wrapped or flat).
// `complete` = payload wasn't truncated by a page limit; a truncated list
// must not override the sidebar's true sqlite message_count. `tokens` is
// omitted entirely when no message reported usage so patchMetrics keeps the
// last good value instead of clobbering it.
export function metricsFromMessages(msgs: any[], complete = true): SessionMetrics {
  const list = msgs ?? []
  const out: SessionMetrics = {}
  for (let i = list.length - 1; i >= 0; i--) {
    const info = (list[i] as any).info ?? list[i]
    if (((info?.role ?? 'assistant') !== 'assistant')) continue
    const t = tokenTally(info?.tokens)
    if (t === undefined) continue
    out.tokens = t
    break
  }
  if (complete) out.messages = list.length
  return out
}

export interface PermRequest {
  id: string
  sessionID?: string
  /** engine field "permission": bash | edit | read | webfetch | ... */
  permission?: string
  patterns?: string[]
  metadata?: Record<string, any>
  tool?: { messageID?: string; callID?: string }
  type?: string
  title?: string
  raw: any
}

// ---- "done & unread" session lights ----
// A session that finished (idle/error) while another tab was being viewed
// gets flagged here so the sidebar shows a green dot until it's opened.
export const sessionUnread = writable<Set<string>>(new Set())

export function markSessionUnread(sid: string) {
  sessionUnread.update((s) => {
    if (s.has(sid)) return s
    const next = new Set(s)
    next.add(sid)
    return next
  })
}

export function clearSessionUnread(sid: string) {
  sessionUnread.update((s) => {
    if (!s.has(sid)) return s
    const next = new Set(s)
    next.delete(sid)
    return next
  })
}

export function preferredDefaultModel(providers: { id: string; models?: Record<string, any> }[]): ModelRef | null {
  // Deployment preference: the opencode provider's free model is the
  // cheapest, generally-available default; don't fall back to the first
  // provider's first model (that's a local lemonade runtime that often
  // isn't running in this environment).
  const opencode = providers.find((p) => p.id === 'opencode')
  if (opencode?.models?.['x-preview-f-free']) {
    return { providerID: 'opencode', modelID: 'x-preview-f-free' }
  }
  const first = providers[0]
  if (!first) return null
  const mid = Object.keys(first.models ?? {})[0]
  return mid ? { providerID: first.id, modelID: mid } : null
}

export const permissions = writable<PermRequest[]>([])

// ---- pending question-tool requests (engine blocks the turn until answered) ----
// Shape (v1.18.x GET /question): { id, sessionID, questions: [{question, header,
// options: [{label, description}], multiple?, custom?}], tool?: {messageID, callID} }
export interface PendingQuestion {
  id: string
  sessionID?: string
  questions: any[]
  tool?: { messageID?: string; callID?: string }
}
export const pendingQuestions = writable<PendingQuestion[]>([])
export const sidebarOpen = writable(true)
export const searchQuery = writable('')
export const paletteOpen = writable(false)
export const sessionTodos = writable<Record<string, any[]>>({})

// ---- display preferences (persisted) ----
export function makePref(key: string, initial = true) {
  const KEY = 'opencode.' + key
  const w = writable<boolean>(
    (() => {
      try {
        const raw = localStorage.getItem(KEY)
        return raw === null ? initial : raw === '1'
      } catch {
        return initial
      }
    })(),
  )
  let cur = false
  w.subscribe((v) => (cur = v))
  function set(v: boolean) {
    w.set(v)
    try {
      localStorage.setItem(KEY, v ? '1' : '0')
    } catch {}
  }
  return { subscribe: w.subscribe, set, toggle: () => set(!cur) }
}

export const showThinking = makePref('showThinking', false) // /thinking expands all blocks
export const showTimestamps = makePref('showTimestamps', true)
export const hideSubagents = makePref('hideSubagents', true) // sidebar: hide @agent sessions by default

// ---- externally-triggered model picker ----
export const modelPickerOpen = writable(false)

// ---- rename-session dialog target (sid + current title); null = closed ----
export const renameTarget = writable<{ sid: string; title: string } | null>(null)

// ---- full-size image viewer (read-tool thumbnails); null = closed ----
export const lightbox = writable<{ src: string; caption?: string } | null>(null)

// ---- transient toast ----
export const toastMsg = writable('')
let toastTimer: ReturnType<typeof setTimeout> | undefined
export function toast(msg: string, ms = 2600) {
  toastMsg.set(msg)
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toastMsg.set(''), ms)
}

// ---- command registry reactivity ----
// bumped when engine commands/skills finish loading so menus refresh
export const cmdVersion = writable(0)

// ---- generic dialog (list rows or plain text), driven by commands.ts ----
export interface DialogRow {
  label: string
  desc?: string
  hint?: string
  onPick?: () => void
}
export interface DialogSpec {
  title: string
  rows?: DialogRow[]
  pre?: string // monospace block (diff, status…)
  note?: string
}
export const dialog = writable<DialogSpec | null>(null)

const INFO_KEY = 'opencode.infoOpen'
export const infoOpen = writable(
  (() => {
    try {
      return localStorage.getItem(INFO_KEY) !== '0'
    } catch {
      return true
    }
  })(),
)
export function toggleInfo() {
  infoOpen.update((v) => {
    try {
      localStorage.setItem(INFO_KEY, v ? '0' : '1')
    } catch {}
    return !v
  })
}

// ---- selected model (persisted) ----
export interface ModelRef {
  providerID: string
  modelID: string
}

const MODEL_KEY = 'opencode.model'
function loadModel(): ModelRef | null {
  try {
    const raw = localStorage.getItem(MODEL_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function makeModel() {
  const { subscribe, set } = writable<ModelRef | null>(loadModel())
  return {
    subscribe,
    save(m: ModelRef | null) {
      set(m)
      try {
        if (m) localStorage.setItem(MODEL_KEY, JSON.stringify(m))
        else localStorage.removeItem(MODEL_KEY)
      } catch {
        /* private mode */
      }
    },
  }
}

export const selectedModel = makeModel()

// ---- recently used models (persisted, most recent first) ----
const RECENTS_KEY = 'opencode.modelRecents'
const RECENTS_CAP = 12

function loadRecentsRaw(): ModelRef[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr)
      ? arr.filter((m) => m && typeof m.providerID === 'string' && typeof m.modelID === 'string')
      : []
  } catch {
    return []
  }
}

// store (not a plain localStorage read) so consumers' reactive statements re-run
// on recordRecent — functions reading localStorage are invisible to the Svelte compiler
export const recentModels = writable<ModelRef[]>(loadRecentsRaw())

// call only from user actions (same invariant as selectedModel) — never from SSE echoes
export function recordRecent(m: ModelRef) {
  recentModels.update((list) => {
    const next = [m, ...list.filter((r) => r.providerID !== m.providerID || r.modelID !== m.modelID)].slice(
      0,
      RECENTS_CAP,
    )
    try {
      localStorage.setItem(RECENTS_KEY, JSON.stringify(next))
    } catch {
      /* private mode */
    }
    return next
  })
}
