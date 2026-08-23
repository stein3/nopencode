import { tabs } from './stores'
import { oc } from './api'
import { refreshPermissions } from './permissions'

const timers = new Map<string, ReturnType<typeof setTimeout>>()

export function refetchNow(sessionId: string) {
  const prev = timers.get(sessionId)
  if (prev) clearTimeout(prev)
  timers.delete(sessionId)
  oc.messages(sessionId)
    .then((msgs) => tabs.patch(sessionId, { messages: normalizeMessages(msgs), dirty: false }))
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
        const msgs = await oc.messages(sessionId)
        tabs.patch(sessionId, { messages: normalizeMessages(msgs), dirty: false })
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
      time: info.time?.created ?? info.time?.created_at ?? 0,
      parts: (m.parts ?? info.parts ?? []).map((p: any) => ({
        id: p.id,
        type: p.type,
        text: p.text,
        tool: p.tool ?? p.toolName,
        state: p.state,
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
    if (!sid) return
    if (!tabs.isopen(sid)) return
    if (type === 'session.idle') tabs.patch(sid, { busy: false })
    else if (type === 'session.error') tabs.patch(sid, { busy: false, error: String(p.error?.message ?? 'error') })

    // true streaming: the engine pushes full part snapshots on every change
    if (type === 'message.part.updated' && p.part?.id) {
      tabs.upsertPart(sid, p.part.messageID, p.part)
      return
    }

    scheduleRefetch(sid)
  }
  es.onerror = () => {
    // EventSource auto-reconnects; re-pull permissions on reconnect
    setTimeout(refreshPermissions, 1500)
  }
}
