// Thin wrappers around the two same-origin backends:
//  - /engine/*  → opencode v2 engine (live REST + SSE, proxied by chatserver)
//  - /api/*     → chatserver.py sqlite history/search

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  if (!r.ok) {
    // Parse the JSON error body when possible so callers can inspect e.g.
    // SessionBusyError (409) without losing the payload.
    let body: any = null
    try { body = await r.json() } catch { /* non-JSON or empty */ }
    const err: any = new Error(`${init?.method ?? 'GET'} ${url} -> ${r.status}`)
    err.status = r.status
    err.body = body
    throw err
  }
  // prompt_async answers 204 No Content
  const t = await r.text()
  return t ? JSON.parse(t) : (undefined as T)
}

// Detect the engine's 409 SessionBusyError — body shape varies across wrapper
// layers (chatserver proxies /engine/* to the engine's /api/* routes).
export function isSessionBusy(e: unknown): boolean {
  const b = (e as any)?.body
  return (e as any)?.status === 409 && (b?.name ?? b?.error?.name) === 'SessionBusyError'
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
  modelID?: string
  providerID?: string
  time?: { created?: number }
  tokens?: Record<string, any>
  parts?: OcPart[]
  // mid-turn turn failure stamped on the assistant message by the engine
  // (persisted; instant fails leave no message — those are SSE/sidecar only)
  error?: any
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

// composer attachment part on prompt_async (verified against live engine:
// stored user-message file parts come back with this same shape)
export interface OcFilePart {
  type: 'file'
  mime: string
  url: string
  filename: string
}

export const oc = {
  sessions: () => req<OcSession[]>('/engine/session'),
  session: (id: string) => req<OcSession>(`/engine/session/${id}`),
  messages: (id: string, limit?: number) =>
    // engine returns the NEWEST `limit` messages in ascending order
    req<OcMessage[]>(`/engine/session/${id}/message${limit ? `?limit=${limit}` : ''}`),
  createSession: (title?: string, model?: { providerID: string; modelID: string; variant?: string }) =>
    req<OcSession>('/engine/session', {
      method: 'POST',
      body: JSON.stringify({
        ...(title ? { title } : {}),
        // engine ModelRef uses `id` — a session created without one inherits
        // the config default, ignoring the picker
        ...(model ? { model: { providerID: model.providerID, id: model.modelID, ...(model.variant ? { variant: model.variant } : {}) } } : {}),
      }),
    }),
  // v2: prompt endpoint (was prompt_async in v1). Returns immediately (204).
  // `agent` (top-level body field) runs this one turn under the named agent;
  // omitted = session default. `files` are composer attachments sent as file
  // parts ordered AFTER the text part.
  prompt: (
    sessionId: string,
    text: string,
    model?: { providerID: string; modelID: string; variant?: string },
    agent?: string,
    files?: OcFilePart[],
  ) =>
    req<unknown>(`/engine/session/${sessionId}/prompt`, {
      method: 'POST',
      body: JSON.stringify({
        parts: [{ type: 'text', text }, ...(files ?? [])],
        ...(model ? { model: { providerID: model.providerID, modelID: model.modelID } } : {}),
        ...(model?.variant ? { variant: model.variant } : {}),
        ...(agent ? { agent } : {}),
      }),
    }),
  // v2: interrupt (was abort in v1)
  abort: (sessionId: string) =>
    req<unknown>(`/engine/session/${sessionId}/interrupt`, { method: 'POST', body: '{}' }),
  // v2: session/active (was session/status in v1)
  status: () => req<Record<string, { type?: string; state?: string; attempt?: number; message?: string; action?: { reason?: string; provider?: string; title?: string; message?: string; label?: string; link?: string }; next?: number }>>('/engine/session/active'),
  // v2: permission/request (was /permission in v1)
  permissions: () => req<any[]>('/engine/permission/request'),
  // v2: session-scoped permission reply with {decision} body
  replyPermission: (requestID: string, reply: 'once' | 'always' | 'reject', sessionId?: string) =>
    req<unknown>(`/engine/session/${sessionId}/permission/${requestID}/reply`, {
      method: 'POST',
      body: JSON.stringify({ decision: reply }),
    }),
  // v2: form (was question in v1). Root route returns all pending forms.
  questions: () => req<any[]>('/engine/form'),
  // v2: session-scoped form reply
  replyQuestion: (requestID: string, answers: string[][], sessionId?: string) =>
    req<unknown>(`/engine/session/${sessionId}/form/${requestID}/reply`, {
      method: 'POST',
      body: JSON.stringify({ answers }),
    }),
  // v2: session-scoped form cancel (DELETE)
  rejectQuestion: (requestID: string, sessionId?: string) =>
    req<unknown>(`/engine/session/${sessionId}/form/${requestID}`, { method: 'DELETE' }),
  // v2: provider list (was /config/providers in v1)
  providers: () =>
    req<{ providers: any[] }>('/engine/provider').then((d) => d.providers ?? d ?? []),
  commands: () => req<{ name: string; description?: string }[]>('/engine/command'),
  todos: (sessionId: string) => req<any[]>(`/engine/session/${sessionId}/todo`).catch(() => []),
  deleteMessage: (sessionId: string, messageID: string) =>
    req<unknown>(`/engine/session/${sessionId}/message/${messageID}`, { method: 'DELETE' }),
  // v2: staged revert (was simple revert in v1)
  revertTo: (sessionId: string, messageID: string) =>
    req<OcSession>(`/engine/session/${sessionId}/revert/stage`, {
      method: 'POST',
      body: JSON.stringify({ messageID }),
    }),
  // v2: command body uses `name` not `command`
  runCommand: (sessionId: string, command: string, args: string[] = []) =>
    req<unknown>(`/engine/session/${sessionId}/command`, {
      method: 'POST',
      body: JSON.stringify({ name: command, arguments: args }),
    }),
  // v2: location (was /path in v1)
  path: () => req<{ directory?: string }>('/engine/location').catch(() => ({ directory: undefined })),
  agents: () =>
    req<{ name: string; mode?: string; description?: string; color?: string | null; hidden?: boolean | null }[]>(
      '/engine/agent',
    ),
  // v2: session-scoped agent switch (fix double /api/ from v1)
  setAgent: (sessionId: string, agent: string) =>
    req<unknown>(`/engine/session/${sessionId}/agent`, {
      method: 'POST',
      body: JSON.stringify({ agent }),
    }),
  // v2: session-scoped model switch (fix double /api/ from v1)
  setSessionModel: (sessionId: string, m: { providerID: string; modelID: string; variant?: string }) =>
    req<unknown>(`/engine/session/${sessionId}/model`, {
      method: 'POST',
      body: JSON.stringify({ model: { providerID: m.providerID, id: m.modelID, ...(m.variant ? { variant: m.variant } : {}) } }),
    }),
  // v2: compact (was summarize in v1)
  summarize: (sessionId: string, model: { providerID: string; modelID: string }) =>
    req<unknown>(`/engine/session/${sessionId}/compact`, { method: 'POST', body: JSON.stringify(model) }),
  // v2: fork uses `before` not `messageID`
  forkSession: (sessionId: string, messageID?: string) =>
    req<OcSession>(`/engine/session/${sessionId}/fork`, {
      method: 'POST',
      body: JSON.stringify(messageID ? { before: messageID } : {}),
    }),
  shareSession: (sessionId: string) =>
    req<OcSession & { share?: { url?: string } }>(`/engine/session/${sessionId}/share`, {
      method: 'POST',
      body: '{}',
    }),
  unshareSession: (sessionId: string) =>
    req<unknown>(`/engine/session/${sessionId}/share`, { method: 'DELETE' }),
  renameSession: (sessionId: string, title: string) =>
    req<OcSession>(`/engine/session/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),
  deleteSession: (sessionId: string) =>
    req<unknown>(`/engine/session/${sessionId}`, { method: 'DELETE' }),
  mcps: () => req<Record<string, any>>('/engine/mcp').catch(() => ({})),
  mcpToggle: (name: string, connect: boolean) =>
    req<unknown>(`/engine/mcp/${encodeURIComponent(name)}/${connect ? 'connect' : 'disconnect'}`, {
      method: 'POST',
      body: '{}',
    }),
  diffRaw: () => reqText('/engine/vcs/diff').catch(() => ''),
  skills: () => req<{ name: string; description?: string; location?: string }[]>('/engine/skill'),
  config: () => req<Record<string, any>>('/engine/config').catch(() => ({})),
  configPatch: (patch: Record<string, any>) =>
    req<Record<string, any>>('/engine/config', {
      method: 'PATCH',
      body: JSON.stringify(patch),
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
  // provider of the session's model (chatserver projects it from the session
  // JSON) — sidebar tooltip shows provider/id while the row shows bare model id
  model_provider?: string
  // context estimate (newest assistant message with a non-zero tally);
  // absent when no message ever reported usage
  tokens?: number
  // set on subagent sessions (@explore, @general, …) — engine session parentID
  parent?: string
  agent?: string
  // server-backed session organization (webui.db smeta table)
  star?: boolean
  tag?: string
}

export interface HistMsg {
  id: string
  role: string
  time: number
  agent?: string
  modelID?: string
  // chatserver currently emits this only if its projection adds it; the
  // client copies it defensively so the tooltip can show provider/model
  providerID?: string
  parts: HistPart[]
}

export interface HistPart {
  id: string
  type: string
  text?: string
  tool?: string
  state_summary?: string
  // engine-injected subagent task results (synthetic user messages)
  synthetic?: boolean | null
}

export interface SearchHit {
  session_id: string
  session_title: string
  message_id: string
  part_id: string
  role: string
  time: number
  snippet: string
  agent?: string
}

// persisted turn-failure tile (chatserver sidecar webui.db — the engine
// records session.error nowhere)
export interface HistErr {
  seq: number
  message: string
  t: number
}

export const hist = {
  sessions: () => req<HistSession[]>('/api/history/sessions'),
  messages: (id: string) => req<HistMsg[]>(`/api/history/session/${id}`),
  search: (q: string) => req<SearchHit[]>(`/api/search?q=${encodeURIComponent(q)}`),
  sessionErrors: (id: string) =>
    req<HistErr[]>(`/api/history/session/${id}/errors`).catch(() => []),
  allErrors: () => req<(HistErr & { sid: string })[]>('/api/history/errors').catch(() => []),
  // fire-and-forget by contract — callers ignore the promise
  addSessionError: (id: string, message: string, t = Date.now()) =>
    req<{ ok: boolean }>(`/api/history/session/${id}/errors`, {
      method: 'POST',
      body: JSON.stringify({ message, t }),
    }).catch(() => {}),
  clearSessionErrors: (id: string) =>
    req<{ ok: boolean }>(`/api/history/session/${id}/errors`, { method: 'DELETE' }).catch(
      () => {},
    ),
  setSessionMeta: (id: string, patch: { star?: boolean; tag?: string | null }) =>
    req<{ ok: boolean; star: boolean; tag: string | null }>(
      `/api/history/session/${id}/meta`,
      { method: 'PUT', body: JSON.stringify(patch) },
    ),
  deleteSessionMeta: (id: string) =>
    req<{ ok: boolean }>(`/api/history/session/${id}/meta`, { method: 'DELETE' }).catch(() => {}),
}
