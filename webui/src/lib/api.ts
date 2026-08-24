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

async function reqText(url: string, init?: RequestInit): Promise<string> {
  const r = await fetch(url, { headers: { 'content-type': 'application/json' }, ...init })
  if (!r.ok) throw new Error(`${init?.method ?? 'GET'} ${url} -> ${r.status}`)
  return r.text()
}

export interface OcRevert {
  messageID?: string
  partID?: string
}

export interface OcSession {
  id: string
  title?: string
  time?: { created?: number; updated?: number }
  version?: string
  revert?: OcRevert | null
  cost?: number
  agent?: string
  model?: { providerID: string; id: string; variant?: string }
}

export interface OcMessage {
  id: string
  role?: string
  agent?: string
  time?: { created?: number }
  tokens?: Record<string, any>
  parts?: OcPart[]
  // v1 engine wraps message data as { info, parts } — both shapes flow through
  info?: Partial<OcMessage> & { sessionID?: string; tokens?: Record<string, any>; cost?: number }
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
  createSession: (title?: string, model?: { providerID: string; modelID: string }) =>
    req<OcSession>('/oc/session', {
      method: 'POST',
      body: JSON.stringify({
        ...(title ? { title } : {}),
        // engine ModelRef uses `id` — a session created without one inherits
        // the config default, ignoring the picker
        ...(model ? { model: { providerID: model.providerID, id: model.modelID } } : {}),
      }),
    }),
  prompt: (sessionId: string, text: string, model?: { providerID: string; modelID: string }) =>
    req<unknown>(`/oc/session/${sessionId}/message`, {
      method: 'POST',
      body: JSON.stringify({ parts: [{ type: 'text', text }], ...(model ? { model } : {}) }),
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
  providers: () =>
    req<{ providers: any[] }>('/oc/config/providers').then((d) => d.providers ?? []),
  commands: () => req<{ name: string; description?: string }[]>('/oc/command'),
  todos: (sessionId: string) => req<any[]>(`/oc/session/${sessionId}/todo`).catch(() => []),
  deleteMessage: (sessionId: string, messageID: string) =>
    req<unknown>(`/oc/session/${sessionId}/message/${messageID}`, { method: 'DELETE' }),
  revertTo: (sessionId: string, messageID: string) =>
    req<OcSession>(`/oc/session/${sessionId}/revert`, {
      method: 'POST',
      body: JSON.stringify({ messageID }),
    }),
  runCommand: (sessionId: string, command: string, args: string[] = []) =>
    req<unknown>(`/oc/session/${sessionId}/command`, {
      method: 'POST',
      body: JSON.stringify({ command, arguments: args }),
    }),
  path: () => req<{ directory?: string }>('/oc/path').catch(() => ({ directory: undefined })),
  agents: () => req<{ name: string; mode?: string; description?: string }[]>('/oc/agent'),
  setAgent: (sessionId: string, agent: string) =>
    req<unknown>(`/oc/api/session/${sessionId}/agent`, {
      method: 'POST',
      body: JSON.stringify({ agent }),
    }),
  // switch the model the CURRENT session uses (engine schema: ModelRef.id)
  setSessionModel: (sessionId: string, m: { providerID: string; modelID: string }) =>
    req<unknown>(`/oc/api/session/${sessionId}/model`, {
      method: 'POST',
      body: JSON.stringify({ model: { providerID: m.providerID, id: m.modelID } }),
    }),
  summarize: (sessionId: string, model: { providerID: string; modelID: string }) =>
    req<unknown>(`/oc/session/${sessionId}/summarize`, { method: 'POST', body: JSON.stringify(model) }),
  forkSession: (sessionId: string) =>
    req<OcSession>(`/oc/session/${sessionId}/fork`, { method: 'POST', body: '{}' }),
  shareSession: (sessionId: string) =>
    req<OcSession & { share?: { url?: string } }>(`/oc/session/${sessionId}/share`, {
      method: 'POST',
      body: '{}',
    }),
  unshareSession: (sessionId: string) =>
    req<unknown>(`/oc/session/${sessionId}/share`, { method: 'DELETE' }),
  renameSession: (sessionId: string, title: string) =>
    req<OcSession>(`/oc/session/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),
  mcps: () => req<Record<string, any>>('/oc/mcp').catch(() => ({})),
  mcpToggle: (name: string, connect: boolean) =>
    req<unknown>(`/oc/mcp/${encodeURIComponent(name)}/${connect ? 'connect' : 'disconnect'}`, {
      method: 'POST',
      body: '{}',
    }),
  diffRaw: () => reqText('/oc/vcs/diff/raw').catch(() => ''),
  skills: () => req<{ name: string; description?: string; location?: string }[]>('/oc/skill'),
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
