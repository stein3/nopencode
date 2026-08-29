import { writable } from 'svelte/store'
import type { OcMessage, OcFilePart } from './api'
import { msgModel } from './util'

// Engine reverts don't delete messages — they mark a revert point on the
// session and the next prompt physically prunes. Until then every client must
// truncate its own view at this boundary.
export interface RevertPoint {
  messageID?: string
  partID?: string
}

// ---- local prompt queue (queued messages are held client-side) ------------
// While a turn is running, the composer enqueues new prompts here instead of
// sending them to the engine. They render in the transcript with a "queued"
// badge and a cancel (↩) action; on session.idle sse.pumpQueue dispatches them
// in order. A queued prompt has no engine presence yet, so canceling it is a
// pure local remove — it never touches the running turn or earlier messages.
export interface QueuedPrompt {
  id: string
  text: string
  files: OcFilePart[]
  model?: ModelRef
  agent?: string
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
  // local pending prompts (held while a turn runs) — dispatched on session.idle
  queue?: QueuedPrompt[]
  pending?: boolean // not created on the engine yet
  partial?: boolean // older messages exist on the engine but aren't loaded yet
  loadingOlder?: boolean // backfill fetch in flight (transcript shows a spinner)
  loading?: boolean // initial content fetch in flight (shows "Loading…")
  jumpTo?: string // message id the transcript should scroll to once rendered
  // draft text handed to the composer of a not-yet-mounted pane (fork-refill:
  // the forked-from message's text lands editable in the new tab's box)
  prefill?: string
}

// ---- open-tab persistence (issue #1) --------------------------------------
// Restores the previously-open session tabs (order + active) after a reload.
// pending-* tabs are deliberately excluded (not engine sessions yet); the
// list is capped to bound startup cost (each restore fetches ~80 messages).
const OPEN_TABS_KEY = 'opencode.openTabs'
const OPEN_TABS_CAP = 20

export interface OpenTabsState {
  ids: string[]
  active: string
}

export function loadOpenTabs(): OpenTabsState | null {
  try {
    const raw = localStorage.getItem(OPEN_TABS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed?.ids)) return null
    const ids = parsed.ids.filter((x: unknown) => typeof x === 'string' && !x.startsWith('pending-'))
    return { ids: ids.slice(0, OPEN_TABS_CAP), active: typeof parsed.active === 'string' ? parsed.active : '' }
  } catch {
    return null
  }
}

function makeTabs() {
  const { subscribe, update, set } = writable<Tab[]>([])
  const { subscribe: subActive, set: setActiveStore } = writable('')
  const openIds = new Set<string>()
  let activeId = ''

  // debounced localStorage write — only the open-set/order/active mutators
  // (open/close/rekey/setActive) call this, never the streaming ones
  let persistTimer: ReturnType<typeof setTimeout> | undefined
  function persistSoon() {
    clearTimeout(persistTimer)
    persistTimer = setTimeout(persistNow, 250)
  }
  function persistNow() {
    let ids: string[] = []
    subscribe((all) => {
      ids = all.map((t) => t.id).filter((id) => !id.startsWith('pending-')).slice(0, OPEN_TABS_CAP)
    })()
    try {
      localStorage.setItem(OPEN_TABS_KEY, JSON.stringify({ v: 1, ids, active: activeId }))
    } catch {
      /* private mode */
    }
  }

  return {
    subscribe,
    active: { subscribe: subActive },
    isopen(id: string) {
      return openIds.has(id)
    },
    open(t: Tab, activate = true) {
      openIds.add(t.id)
      update((tabs) => {
        const i = tabs.findIndex((x) => x.id === t.id)
        if (i >= 0) return tabs.map((tab, idx) => (idx === i ? { ...tab, ...t } : tab))
        return [...tabs, t]
      })
      if (activate) {
        activeId = t.id
        setActiveStore(t.id)
      }
      persistSoon()
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
      persistSoon()
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
      persistSoon()
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
          // bare base: the message.part.updated event carries only the part —
          // no agent/model info. setMeta fills those from the message.updated
          // event that follows moments later.
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
    // Remove one sidecar error tile by index (dismiss button)
    dismissError(id: string, idx: number) {
      update((tabs) =>
        tabs.map((t) => {
          if (t.id !== id) return t
          const errors = [...(t.errors ?? [])]
          errors.splice(idx, 1)
          return { ...t, errors }
        }),
      )
    },
    // Clear all sidecar errors for a session (e.g. on idle — the error
    // condition has resolved; persisted via DELETE on the chatserver)
    clearErrors(id: string) {
      update((tabs) => tabs.map((t) => (t.id === id ? { ...t, errors: [] } : t)))
    },
    setActive(id: string) {
      activeId = id
      setActiveStore(id)
      persistSoon()
    },
    getActive(): string {
      return activeId
    },
    // immediate flush for the restore path (App prunes dead ids after restoring)
    persist: persistNow,
  }
}

export const tabs = makeTabs()

// ---- local prompt queue ------------------------------------------------
// Queued prompts live on the tab so the transcript can render/cancel them and
// sse.pumpQueue can dispatch them when the session goes idle.
let queueSeq = 0
export function enqueuePrompt(sid: string, item: Omit<QueuedPrompt, 'id'>) {
  const t = tabs.snapshot(sid)
  if (!t) return
  const q: QueuedPrompt = { ...item, id: `q-${queueSeq++}` }
  tabs.patch(sid, { queue: [...(t.queue ?? []), q] })
}
export function cancelQueuedPrompt(sid: string, id: string) {
  const t = tabs.snapshot(sid)
  if (!t?.queue) return
  tabs.patch(sid, { queue: t.queue.filter((q) => q.id !== id) })
}
// Remove and return the oldest queued prompt for dispatch (null when empty).
export function dequeueFirstPrompt(sid: string): QueuedPrompt | null {
  const t = tabs.snapshot(sid)
  if (!t?.queue?.length) return null
  const [first, ...rest] = t.queue
  tabs.patch(sid, { queue: rest })
  return first
}

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

// ---- session parent→children map (for token roll-up in Footer/InfoPanel) ---
// Sidebar builds kidsMap from the full session list; this writable mirrors it
// so other components can compute rolled-up descendant tokens without
// duplicating the session-list fetch.
export const sessionKidMap = writable<Map<string, { id: string; tokens?: number }[]>>(new Map())

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
  // Prefer the `opencode` provider's free tier — generally available and cheap.
  // Avoid the first provider's first model: that's often a local runtime
  // (e.g. lemonade) that isn't running in this environment.
  const opencode = providers.find((p) => p.id === 'opencode')
  if (opencode?.models) {
    // legacy id, kept for back-compat with older engine catalogs
    if (opencode.models['x-preview-f-free']) {
      return { providerID: 'opencode', modelID: 'x-preview-f-free' }
    }
    // current primary free model, then any other free model (ids end in "-free")
    if (opencode.models['hy3-free']) {
      return { providerID: 'opencode', modelID: 'hy3-free' }
    }
    const free = Object.keys(opencode.models).find((id) => id.endsWith('-free'))
    if (free) return { providerID: 'opencode', modelID: free }
    // otherwise the first opencode model
    const first = Object.keys(opencode.models)[0]
    if (first) return { providerID: 'opencode', modelID: first }
  }
  // last resort: first provider's first model
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
// true while a ctrl+x leader chord is armed (drives the WhichKey hint strip)
export const chordPending = writable(false)
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

// ---- numeric preference helper (same localStorage pattern as makePref) ----
function makePrefNum(key: string, initial: number) {
  const KEY = 'opencode.' + key
  const w = writable<number>(
    (() => {
      try {
        const raw = localStorage.getItem(KEY)
        return raw === null ? initial : Number(raw) || initial
      } catch {
        return initial
      }
    })(),
  )
  w.subscribe((v) => {
    try {
      localStorage.setItem(KEY, String(v))
    } catch {}
  })
  return w
}

// ---- retry preferences (read by retries.ts) ----
export const autoRetry = makePref('autoRetry', true) // enable webui auto-retry for retryable errors
export const retryMaxAttempts = makePrefNum('retryMaxAttempts', 0) // 0 = unlimited
export const retryMaxDelay = makePrefNum('retryMaxDelay', 300) // cap on backoff delay (seconds)

// ---- engine-reported retry state (from session.next.retried SSE events) ----
// The engine retries certain errors server-side (e.g. provider quota with
// retry-after header). These retries are separate from the webui's own
// auto-retry loop. This store tracks the engine's retry status per session
// so Transcript can render a distinct countdown banner.
export interface EngineRetryInfo {
  attempt: number
  error?: any
  ts: number // event timestamp
}
export const engineRetries = writable<Record<string, EngineRetryInfo>>({})

export function patchEngineRetry(sid: string, info: EngineRetryInfo) {
  engineRetries.update((all) => ({ ...all, [sid]: info }))
}
export function clearEngineRetry(sid: string) {
  engineRetries.update((all) => {
    const next = { ...all }
    delete next[sid]
    return next
  })
}

// ---- theme store (string-valued, not boolean) ----
const THEME_KEY = 'opencode.theme'
export const theme = writable<string>(
  (() => {
    try {
      return localStorage.getItem(THEME_KEY) || 'graphite'
    } catch {
      return 'graphite'
    }
  })(),
)
theme.subscribe((v) => {
  try {
    localStorage.setItem(THEME_KEY, v)
  } catch {}
})

// ---- sidebar: EXPANDED subagent groups (persisted set of parent sessionIDs) ----
// Inverted on purpose: an empty set = every group collapsed (the default), and
// unknown/new parents collapse automatically without any migration.
const SUB_EXPANDED_KEY = 'opencode.subExpanded'
export const subExpanded = (() => {
  let initial = new Set<string>()
  try {
    const raw = localStorage.getItem(SUB_EXPANDED_KEY)
    if (raw) initial = new Set(JSON.parse(raw) as string[])
  } catch {
    /* private mode etc. */
  }
  const w = writable(initial)
  let cur = initial
  w.subscribe((v) => (cur = v))
  return {
    subscribe: w.subscribe,
    toggle(id: string) {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      w.set(next)
      try {
        localStorage.setItem(SUB_EXPANDED_KEY, JSON.stringify([...next]))
      } catch {}
    },
  }
})()

// ---- externally-triggered model picker ----
export const modelPickerOpen = writable(false)

// ---- settings page (gear button in the sidebar) ----
export const settingsOpen = writable(false)

// ---- rename-session dialog target (sid + current title); null = closed ----
export const renameTarget = writable<{ sid: string; title: string } | null>(null)

// ---- sidebar session-list refresh signal ----
// Bump this counter from any code path that mutates the session list
// (create, rename, cross-client SSE title change) to trigger an immediate
// sidebar reload instead of waiting for the 60 s poll.
export const sessionListDirty = writable(0)
export function markSessionListDirty() {
  sessionListDirty.update((n) => n + 1)
}

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
export function closeInfo() {
  infoOpen.set(false)
  try { localStorage.setItem(INFO_KEY, '0') } catch {}
}

const MCP_KEY = 'opencode.mcpOpen'
export const mcpOpen = writable(
  (() => {
    try {
      // On small/mobile viewports, never auto-open the MCP panel on load —
      // it dominates the narrow screen. Desktop respects the persisted choice.
      const isMobile = typeof window !== 'undefined' && window.matchMedia('(max-width: 600px)').matches
      if (isMobile) return false
      return localStorage.getItem(MCP_KEY) === '1'
    } catch {
      return false
    }
  })(),
)
export function toggleMcp() {
  mcpOpen.update((v) => {
    try {
      localStorage.setItem(MCP_KEY, v ? '0' : '1')
    } catch {}
    return !v
  })
}
export function closeMcp() {
  mcpOpen.set(false)
  try { localStorage.setItem(MCP_KEY, '0') } catch {}
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

// ---- per-session agent pick (composer "agent for new messages") ----
// Scoped to ONE session on purpose: a pick must never leak into other tabs or
// new sessions. Keyed by tab/session id; a missing key = Auto = omit the
// `agent` field from the prompt payload so the engine uses that session's
// default. Written ONLY by explicit user picks in AgentPicker — never echo
// session.agent / SSE session.updated data back into it. Persisted per
// session (recency-pruned) so reloading mid-task keeps the session's pick.
const SESSION_AGENTS_KEY = 'opencode.sessionAgents'
const SESSION_AGENTS_CAP = 200

function loadSessionAgents(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SESSION_AGENTS_KEY)
    const obj = raw ? JSON.parse(raw) : null
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(obj)) if (k && typeof v === 'string') out[k] = v
      return out
    }
  } catch {
    /* private mode */
  }
  return {}
}

function persistSessionAgents(all: Record<string, string>) {
  try {
    localStorage.setItem(SESSION_AGENTS_KEY, JSON.stringify(all))
  } catch {
    /* private mode */
  }
}

export const sessionAgents = writable<Record<string, string>>(loadSessionAgents())

// Sync read for send paths outside Svelte reactivity (Composer.submit,
// retries.fire). Always keyed by the REAL session id being prompted.
export function sessionAgent(sid: string): string | undefined {
  if (!sid) return undefined
  let v: string | undefined
  sessionAgents.subscribe((all) => (v = all[sid]))()
  return v
}

// Insertion order doubles as recency order: the picked sid is re-appended
// last and the oldest entries past the cap fall off.
export function setSessionAgent(sid: string, agent: string | undefined) {
  if (!sid) return
  sessionAgents.update((all) => {
    const next: Record<string, string> = {}
    for (const [k, v] of Object.entries(all)) if (k !== sid) next[k] = v
    if (agent) next[sid] = agent
    const keys = Object.keys(next)
    for (const k of keys.slice(0, Math.max(0, keys.length - SESSION_AGENTS_CAP))) delete next[k]
    persistSessionAgents(next)
    return next
  })
}

// A pending-* tab realized into a real session: carry its pick across the id
// swap (call right after tabs.rekey).
export function rekeySessionAgent(oldId: string, newId: string) {
  if (!oldId || oldId === newId) return
  const cur = sessionAgent(oldId)
  if (cur === undefined) return
  setSessionAgent(newId, cur)
  setSessionAgent(oldId, undefined)
}

// ---- per-session model pick (composer "model for new messages") ----
// Same pattern as sessionAgents: scoped to ONE session, keyed by tab/session
// id. A missing key falls back to the global `selectedModel` (or the engine
// config default). Written ONLY by explicit user picks in ComposerModelPicker.
// Persisted per session so reloading mid-task keeps the session's pick.
const SESSION_MODELS_KEY = 'opencode.sessionModels'
const SESSION_MODELS_CAP = 200

function loadSessionModels(): Record<string, ModelRef> {
  try {
    const raw = localStorage.getItem(SESSION_MODELS_KEY)
    const obj = raw ? JSON.parse(raw) : null
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const out: Record<string, ModelRef> = {}
      for (const [k, v] of Object.entries(obj))
        if (k && typeof v === 'object' && v && typeof (v as any).providerID === 'string' && typeof (v as any).modelID === 'string')
          out[k] = v as ModelRef
      return out
    }
  } catch {
    /* private mode */
  }
  return {}
}

function persistSessionModels(all: Record<string, ModelRef>) {
  try {
    localStorage.setItem(SESSION_MODELS_KEY, JSON.stringify(all))
  } catch {
    /* private mode */
  }
}

export const sessionModels = writable<Record<string, ModelRef>>(loadSessionModels())

// Sync read for send paths outside Svelte reactivity (Composer.submit,
// retries.fire). Always keyed by the REAL session id being prompted.
export function sessionModel(sid: string): ModelRef | undefined {
  if (!sid) return undefined
  let v: ModelRef | undefined
  sessionModels.subscribe((all) => (v = all[sid]))()
  return v
}

// Insertion order doubles as recency order: the picked sid is re-appended
// last and the oldest entries past the cap fall off.
export function setSessionModel(sid: string, model: ModelRef | undefined) {
  if (!sid) return
  sessionModels.update((all) => {
    const next: Record<string, ModelRef> = {}
    for (const [k, v] of Object.entries(all)) if (k !== sid) next[k] = v
    if (model) next[sid] = model
    const keys = Object.keys(next)
    for (const k of keys.slice(0, Math.max(0, keys.length - SESSION_MODELS_CAP))) delete next[k]
    persistSessionModels(next)
    return next
  })
}

// A pending-* tab realized into a real session: carry its pick across the id
// swap (call right after tabs.rekey).
export function rekeySessionModel(oldId: string, newId: string) {
  if (!oldId || oldId === newId) return
  const cur = sessionModel(oldId)
  if (cur === undefined) return
  setSessionModel(newId, cur)
  setSessionModel(oldId, undefined)
}

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

export function clearRecentModels() {
  recentModels.set([])
  try {
    localStorage.removeItem(RECENTS_KEY)
  } catch {
    /* private mode */
  }
}

// ---- per-session metadata (stars, tags, folders) ----------------------------
// Client-only organization: stars (favorites), tags, and folder assignments.
// Persisted in localStorage like sessionAgents/sessionModels — same recency
// cap, same wipe-on-clearLocalData path (already covered by the opencode.*
// prefix match).
export interface SessionMeta {
  star?: boolean
  tags?: string[]
  folder?: string
}

const SESSION_META_KEY = 'opencode.sessionMeta'
const SESSION_META_CAP = 200

function loadSessionMeta(): Record<string, SessionMeta> {
  try {
    const raw = localStorage.getItem(SESSION_META_KEY)
    const obj = raw ? JSON.parse(raw) : null
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const out: Record<string, SessionMeta> = {}
      for (const [k, v] of Object.entries(obj)) {
        if (k && typeof v === 'object' && v !== null) out[k] = v as SessionMeta
      }
      return out
    }
  } catch {
    /* private mode */
  }
  return {}
}

function persistSessionMeta(all: Record<string, SessionMeta>) {
  try {
    localStorage.setItem(SESSION_META_KEY, JSON.stringify(all))
  } catch {
    /* private mode */
  }
}

export const sessionMeta = writable<Record<string, SessionMeta>>(loadSessionMeta())

// Sync read for paths outside Svelte reactivity
export function getSessionMeta(sid: string): SessionMeta | undefined {
  if (!sid) return undefined
  let v: SessionMeta | undefined
  sessionMeta.subscribe((all) => (v = all[sid]))()
  return v
}

// Recency-capped mutation — re-appends the sid as most-recently-updated
function mutateMeta(sid: string, patch: SessionMeta) {
  if (!sid) return
  sessionMeta.update((all) => {
    const next: Record<string, SessionMeta> = {}
    for (const [k, v] of Object.entries(all)) if (k !== sid) next[k] = v
    next[sid] = { ...next[sid], ...patch }
    const keys = Object.keys(next)
    for (const k of keys.slice(0, Math.max(0, keys.length - SESSION_META_CAP))) delete next[k]
    persistSessionMeta(next)
    return next
  })
}

export function toggleStar(sid: string) {
  if (!sid) return
  sessionMeta.update((all) => {
    const cur = all[sid]
    const starred = !(cur?.star)
    const next: Record<string, SessionMeta> = {}
    for (const [k, v] of Object.entries(all)) if (k !== sid) next[k] = v
    if (starred) next[sid] = { ...cur, star: true }
    else if (cur) {
      const { star: _, ...rest } = cur
      if (rest.tags?.length || rest.folder) next[sid] = rest
    }
    const keys = Object.keys(next)
    for (const k of keys.slice(0, Math.max(0, keys.length - SESSION_META_CAP))) delete next[k]
    persistSessionMeta(next)
    return next
  })
}

export function setTags(sid: string, tags: string[]) {
  if (!sid) return
  mutateMeta(sid, { tags: tags.length ? tags : undefined })
}

export function addTag(sid: string, tag: string) {
  if (!sid || !tag) return
  sessionMeta.update((all) => {
    const cur = all[sid] ?? {}
    const existing = cur.tags ?? []
    if (existing.includes(tag)) return all
    const next: Record<string, SessionMeta> = {}
    for (const [k, v] of Object.entries(all)) if (k !== sid) next[k] = v
    next[sid] = { ...cur, tags: [...existing, tag] }
    persistSessionMeta(next)
    return next
  })
}

export function removeTag(sid: string, tag: string) {
  if (!sid || !tag) return
  sessionMeta.update((all) => {
    const cur = all[sid]
    if (!cur?.tags?.includes(tag)) return all
    const next: Record<string, SessionMeta> = {}
    for (const [k, v] of Object.entries(all)) if (k !== sid) next[k] = v
    const tags = cur.tags.filter((t) => t !== tag)
    if (tags.length) next[sid] = { ...cur, tags }
    else if (cur.star || cur.folder) next[sid] = { ...cur, tags: undefined }
    const keys = Object.keys(next)
    for (const k of keys.slice(0, Math.max(0, keys.length - SESSION_META_CAP))) delete next[k]
    persistSessionMeta(next)
    return next
  })
}

export function setFolder(sid: string, folder: string | undefined) {
  if (!sid) return
  mutateMeta(sid, { folder })
}

// Collect all unique tags across all sessions
export function allTags(meta: Record<string, SessionMeta>): string[] {
  const set = new Set<string>()
  for (const v of Object.values(meta)) {
    if (v.tags) for (const t of v.tags) set.add(t)
  }
  return [...set].sort()
}

// Collect all unique folder names across all sessions
export function allFolders(meta: Record<string, SessionMeta>): string[] {
  const set = new Set<string>()
  for (const v of Object.values(meta)) {
    if (v.folder) set.add(v.folder)
  }
  return [...set].sort()
}

// ---- destructive: wipe every local preference --------------------------------
// Every app key in localStorage is namespaced `opencode.` (prefs, model/agent
// picks, recents, open-tab restore, expanded subagent groups), so the settings
// page's "clear all local data" only removes those — anything else on the
// origin is left alone. Server-side sessions are untouched. The caller should
// location.reload() right after so stores re-seed from the clean state.
export function clearLocalData() {
  try {
    const doomed: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith('opencode.')) doomed.push(k)
    }
    for (const k of doomed) localStorage.removeItem(k)
  } catch {
    /* private mode */
  }
}
