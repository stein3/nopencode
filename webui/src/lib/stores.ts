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
