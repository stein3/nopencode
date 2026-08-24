import { writable } from 'svelte/store'
import type { OcMessage } from './api'

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
  messages: OcMessage[]
  live: boolean // engine-backed vs pure history snapshot
  busy?: boolean
  dirty?: boolean // refetch pending
  error?: string
  revert?: RevertPoint | null
  pending?: boolean // not created on the engine yet
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
      update((all) =>
        all.map((t) => {
          if (t.id !== sid) return t
          const exists = t.messages.some((x) => x.id === info.id)
          if (!exists) return t
          return {
            ...t,
            messages: t.messages.map((x) =>
              x.id === info.id
                ? { ...x, role: info.role ?? x.role, agent: info.agent ?? x.agent, time: info.time ?? x.time }
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

// Derive metrics from a raw engine messages payload (info-wrapped or flat).
export function metricsFromMessages(msgs: any[]): SessionMetrics {
  const list = msgs ?? []
  const withTok = [...list]
    .reverse()
    .find((m: any) => ((m.info ?? m)?.role ?? 'assistant') === 'assistant' && (m.info ?? m)?.tokens)
  const t = withTok ? ((withTok.info ?? withTok).tokens ?? {}) : {}
  const tokens =
    (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + ((t.cache?.read ?? 0) + (t.cache?.write ?? 0))
  return { tokens, messages: list.length }
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

export const permissions = writable<PermRequest[]>([])
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

// ---- externally-triggered model picker ----
export const modelPickerOpen = writable(false)

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
