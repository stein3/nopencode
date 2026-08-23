// Thin wrappers around the two same-origin backends:
//  - /oc/*   → opencode engine (live REST + SSE)
//  - /api/*  → chatserver.py sqlite history/search

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  if (!r.ok) throw new Error(`${init?.method ?? 'GET'} ${url} -> ${r.status}`)
  return r.json()
}

export interface OcSession {
  id: string
  title?: string
  time?: { created?: number; updated?: number }
  version?: string
}

export interface OcMessage {
  id: string
  role?: string
  agent?: string
  time?: { created?: number }
  parts?: OcPart[]
}

export interface OcPart {
  id: string
  type: string
  text?: string
  tool?: string
  state?: any
  [k: string]: any
}

export const oc = {
  sessions: () => req<OcSession[]>('/oc/session'),
  session: (id: string) => req<OcSession>(`/oc/session/${id}`),
  messages: (id: string) => req<OcMessage[]>(`/oc/session/${id}/message`),
  createSession: (title?: string) =>
    req<OcSession>('/oc/session', { method: 'POST', body: JSON.stringify(title ? { title } : {}) }),
  prompt: (sessionId: string, text: string) =>
    req<unknown>(`/oc/session/${sessionId}/message`, {
      method: 'POST',
      body: JSON.stringify({ parts: [{ type: 'text', text }] }),
    }),
  abort: (sessionId: string) =>
    req<unknown>(`/oc/session/${sessionId}/abort`, { method: 'POST', body: '{}' }),
  status: () => req<Record<string, { type?: string; state?: string }>>('/oc/session/status'),
  permissions: () => req<any[]>('/oc/permission'),
  replyPermission: (requestID: string, reply: 'once' | 'always' | 'reject') =>
    req<unknown>(`/oc/permission/${requestID}/reply`, {
      method: 'POST',
      body: JSON.stringify({ reply }),
    }),
}

// ---- history (sqlite via chatserver.py) ----

export interface HistSession {
  id: string
  title: string
  created: number
  updated: number
  message_count: number
  cost: number
  model?: string
}

export interface HistMsg {
  id: string
  role: string
  time: number
  agent?: string
  modelID?: string
  parts: HistPart[]
}

export interface HistPart {
  id: string
  type: string
  text?: string
  tool?: string
  state_summary?: string
}

export interface SearchHit {
  session_id: string
  session_title: string
  message_id: string
  part_id: string
  role: string
  snippet: string
}

export const hist = {
  sessions: () => req<HistSession[]>('/api/history/sessions'),
  messages: (id: string) => req<HistMsg[]>(`/api/history/session/${id}`),
  search: (q: string) => req<SearchHit[]>(`/api/search?q=${encodeURIComponent(q)}`),
}
