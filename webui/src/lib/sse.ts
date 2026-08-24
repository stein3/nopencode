import { tabs, sessionTodos, patchMetrics, metricsFromMessages, markSessionUnread } from './stores'
import { oc } from './api'
import { refreshPermissions } from './permissions'
import { refreshQuestions } from './questions'

const timers = new Map<string, ReturnType<typeof setTimeout>>()

// Transcript loads are windowed: the newest RECENT_PAGE messages render first
// (that's all the footer/info panel need for tokens/cost), older history is
// fetched once on upward scroll. Engine `?before=` paging 400s server-side, so
// backfill does one full fetch instead of true pages.
export const RECENT_PAGE = 80

function byCreated(a: any, b: any) {
  return (a.time?.created ?? 0) - (b.time?.created ?? 0) || String(a.id).localeCompare(String(b.id))
}

// One code path for "we now have the engine's view of this session's
// messages": updates the tab AND the shared sidebar metrics. `complete` means
// the payload wasn't truncated by a limit — partial merges keep any
// older-loaded prefix (union by id) so backfill work is never undone.
export function applyMessages(sessionId: string, msgs: any[], complete = true) {
  const cur = tabs.snapshot(sessionId)
  if (!cur) return
  const fetched = normalizeMessages(msgs)
  let next = fetched
  if (cur.partial && !complete && cur.messages.length) {
    const ids = new Set(fetched.map((m) => m.id))
    const older = cur.messages.filter((m) => !ids.has(m.id))
    if (older.length) next = [...older, ...fetched].sort(byCreated)
  }
  // identical id-set + unchanged partial state → skip the swap: a new Tab
  // object re-fires every consumer (Footer refetches, Transcript re-renders),
  // which otherwise self-amplifies into a fetch loop
  const partialNext = !complete || !!cur.partial
  const sameIds =
    next.length === cur.messages.length &&
    next.every((m, i) => m.id === cur.messages[i].id)
  if (sameIds && !!cur.partial === partialNext && !cur.dirty) {
    patchMetrics(sessionId, metricsFromMessages(msgs, complete))
    return
  }
  tabs.patch(sessionId, {
    messages: next,
    dirty: false,
    // an incomplete payload means older history exists; once complete, any
    // previous partial state is resolved
    partial: partialNext,
  })
  patchMetrics(sessionId, metricsFromMessages(msgs, complete))
}

// Full catch-up for a windowed session (scroll-up, transcript export, search
// jumps into old history). No-op when everything is already loaded.
export async function backfill(sessionId: string): Promise<void> {
  const t = tabs.snapshot(sessionId)
  if (!t?.partial || t.loadingOlder) return
  tabs.patch(sessionId, { loadingOlder: true })
  try {
    applyMessages(sessionId, await oc.messages(sessionId))
  } finally {
    tabs.patch(sessionId, { loadingOlder: false })
  }
}

// One incremental older-history page for the transcript scroll-up path. Uses
// the cumulative-limit trick (fetch newest N+k, merge keeps the overlap) since
// the engine's `before` cursor 400s server-side. Rendering stays chunked, so
// huge sessions never block in one giant update.
const OLDER_CHUNK = 120

export async function loadOlder(sessionId: string): Promise<void> {
  const t = tabs.snapshot(sessionId)
  if (!t?.partial || t.loadingOlder || !t.live) return
  tabs.patch(sessionId, { loadingOlder: true })
  try {
    const want = t.messages.length + OLDER_CHUNK
    const msgs = await oc.messages(sessionId, want)
    applyMessages(sessionId, msgs, msgs.length < want)
  } finally {
    tabs.patch(sessionId, { loadingOlder: false })
  }
}

export function refetchNow(sessionId: string) {
  const prev = timers.get(sessionId)
  if (prev) clearTimeout(prev)
  timers.delete(sessionId)
  oc.messages(sessionId, RECENT_PAGE)
    .then((msgs) => applyMessages(sessionId, msgs, msgs.length < RECENT_PAGE))
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
        const msgs = await oc.messages(sessionId, RECENT_PAGE)
        applyMessages(sessionId, msgs, msgs.length < RECENT_PAGE)
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
      modelID: info.modelID,
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
  refreshQuestions()
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

    // question.asked / .replied / .rejected (and .v2 variants) drive the
    // pending-question picker; permissions keep their own refresh
    if (/permission/i.test(type)) refreshPermissions()
    if (/question/i.test(type)) refreshQuestions()

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
