import { tabs, sessionTodos, patchMetrics, metricsFromMessages, markSessionUnread } from './stores'
import { oc } from './api'
import { refreshPermissions } from './permissions'

const timers = new Map<string, ReturnType<typeof setTimeout>>()

// One code path for "we now have the engine's view of this session's
// messages": updates the tab AND the shared sidebar metrics.
export function applyMessages(sessionId: string, msgs: any[]) {
  tabs.patch(sessionId, { messages: normalizeMessages(msgs), dirty: false })
  patchMetrics(sessionId, metricsFromMessages(msgs))
}

export function refetchNow(sessionId: string) {
  const prev = timers.get(sessionId)
  if (prev) clearTimeout(prev)
  timers.delete(sessionId)
  oc.messages(sessionId)
    .then((msgs) => applyMessages(sessionId, msgs))
    .catch(() => {})
}

function scheduleRefetch(sessionId: string) {
  tabs.patch(sessionId, { dirty: true })
  const prev = timers.get(sessionId)
  if (prev) clearTimeout(prev)
  timers.set(
    sessionId,
    setTimeout(async () => {
      timers.delete(sessionId)
      try {
        applyMessages(sessionId, await oc.messages(sessionId))
      } catch {
        /* tab may be closed */
      }
    }, 350),
  )
}

// Engine part/message shapes vary slightly across versions; normalize defensively.
export function normalizeMessages(msgs: any[]): any[] {
  return (msgs ?? []).map((m: any) => {
    const info = m.info ?? m
    return {
      id: info.id,
      role: info.role ?? 'assistant',
      // keep the { created } object shape used everywhere else (OcMessage,
      // upsertPart, setMeta) — flattening here silently killed timestamps
      time: { created: info.time?.created ?? info.time?.created_at ?? Date.now() },
      parts: (m.parts ?? info.parts ?? []).map((p: any) => ({
        id: p.id,
        type: p.type,
        text: p.text,
        tool: p.tool ?? p.toolName,
        state: p.state,
        callID: p.callID, // question picker matches pending requests by callID
      })),
    }
  })
}

export function startEvents() {
  refreshPermissions()
  const es = new EventSource('/oc/event')
  es.onmessage = (ev) => {
    let data: any
    try {
      data = JSON.parse(ev.data)
    } catch {
      return
    }
    const type: string = data.type ?? ''
    const p = data.properties ?? {}
    // Engine event shapes vary: sessionID lives at different paths per type
    // (session.idle → .sessionID, message.updated → .info.sessionID,
    //  message.part.updated → .part.sessionID, session.updated → .info.id …)
    const sid: string | undefined =
      p.sessionID ??
      p.info?.sessionID ??
      p.info?.id ??
      p.part?.sessionID ??
      p.message?.sessionID ??
      p.properties?.sessionID

    if (/permission|question/i.test(type)) refreshPermissions()

    // todo lists arrive whole — stash them for the info panel
    if (type === 'todo.updated' && Array.isArray(p.todos)) {
      if (!sid) return
      sessionTodos.update((m) => ({ ...m, [sid]: p.todos }))
      return
    }

    if (!sid) return
    if (!tabs.isopen(sid)) return
    if (type === 'session.idle') {
      tabs.patch(sid, { busy: false })
      // finished while another tab is being viewed → flag done/unread
      if (tabs.getActive() !== sid) markSessionUnread(sid)
    } else if (type === 'session.error') {
      tabs.patch(sid, { busy: false, error: String(p.error?.message ?? 'error') })
      if (tabs.getActive() !== sid) markSessionUnread(sid)
    }

    // true streaming: snapshots replace, deltas append
    if (type === 'message.part.updated' && p.part?.id) {
      tabs.upsertPart(sid, p.part.messageID ?? p.messageID, p.part)
      return
    }
    if (type === 'message.part.delta' && p.partID && typeof p.delta === 'string') {
      tabs.appendDelta(sid, p.messageID, p.partID, p.field, p.delta)
      // fall through: debounced refetch covers deltas that landed before
      // their message materialized locally
    } else if (type === 'message.updated' && p.info?.id) {
      tabs.setMeta(sid, p.info)
      // assistant message info carries the live token tally + per-message cost
      if (p.info.tokens)
        patchMetrics(sid, {
          tokens:
            (p.info.tokens.input ?? 0) +
            (p.info.tokens.output ?? 0) +
            (p.info.tokens.reasoning ?? 0) +
            ((p.info.tokens.cache?.read ?? 0) + (p.info.tokens.cache?.write ?? 0)),
        })
      scheduleRefetch(sid)
    } else if (type === 'session.updated' && p.info) {
      // carries authoritative revert state: set by a revert, cleared when the
      // next prompt prunes the reverted messages server-side
      tabs.patch(sid, { revert: p.info.revert ?? null })
      patchMetrics(sid, { cost: p.info.cost, updated: p.info.time?.updated })
      // follow renames / auto-titles (e.g. "New Session" → real title)
      if (p.info.title && tabs.snapshot(sid)?.title !== p.info.title)
        tabs.patch(sid, { title: p.info.title })
      // NOTE: deliberately no selectedModel.save here — these events stream
      // all through an in-flight turn carrying its OLD model, so echoing them
      // into the picker silently reverted a fresh user pick before the next
      // send. The picker is now purely user-driven; prompts always carry it.
      scheduleRefetch(sid)
    } else {
      scheduleRefetch(sid)
    }
  }
  es.onerror = () => {
    // EventSource auto-reconnects; re-pull permissions on reconnect
    setTimeout(refreshPermissions, 1500)
  }
}
