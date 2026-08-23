import { writable } from 'svelte/store'
import type { OcMessage } from './api'

export interface Tab {
  id: string // session id
  title: string
  messages: OcMessage[]
  live: boolean // engine-backed vs pure history snapshot
  busy?: boolean
  dirty?: boolean // refetch pending
  error?: string
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

export interface PermRequest {
  id: string
  sessionID?: string
  type?: string
  title?: string
  raw: any
}

export const permissions = writable<PermRequest[]>([])
export const sidebarOpen = writable(true)
export const searchQuery = writable('')
export const paletteOpen = writable(false)

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
