import { tabs, sessionTodos, patchMetrics, metricsFromMessages, tokenTally, markSessionUnread } from './stores'
import { oc, hist } from './api'
import { refreshPermissions } from './permissions'
import { refreshQuestions } from './questions'
import { msgModel } from './util'
import { isRetryableError, scheduleRetry, onTurnIdle } from './retries'

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
// `cap` bounds the fetch to the newest N messages — anchor jumps use this to
// avoid materializing multi-MB transcripts; the caller checks whether the
// anchor actually landed and retries uncapped when it sits deeper than the
// window.
export async function backfill(sessionId: string, cap?: number): Promise<void> {
  const t = tabs.snapshot(sessionId)
  if (!t?.partial || t.loadingOlder) return
  tabs.patch(sessionId, { loadingOlder: true })
  try {
    if (cap === undefined) {
      applyMessages(sessionId, await oc.messages(sessionId))
    } else {
      const msgs = await oc.messages(sessionId, cap)
      applyMessages(sessionId, msgs, msgs.length < cap)
    }
  } finally {
    tabs.patch(sessionId, { loadingOlder: false })
  }
}

// Anchor-jump backfills only need the hit to be present; anything older is
// reachable via scroll-up paging. Deep anchors fall back to a full fetch.
export const JUMP_CAP = 600

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
    // assistant info carries flat modelID/providerID, user info nests them
    // under `model` — msgModel reads both so user rows get their badge too
    const mm = msgModel(info)
    return {
      id: info.id,
      role: info.role ?? 'assistant',
      // engine stamps `agent` on every message (user + assistant) — dropping it
      // here made Transcript's role label fall back to 'opencode' after each
      // refetch/reload
      agent: info.agent ?? undefined,
      modelID: mm.modelID,
      providerID: mm.providerID,
      error: info.error,
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
      // turn ended without a fresh error → a pending retry loop is done
      onTurnIdle(sid)
      // finished while another tab is being viewed → flag done/unread
      if (tabs.getActive() !== sid) markSessionUnread(sid)
    } else if (type === 'session.error') {
      // readable text sits at error.data.message on most engine errors.
      // User aborts fire this event too (MessageAbortedError) — the TUI
      // excludes them from error surfacing, and so do we: the aborted
      // assistant message renders a muted note, no red tile, no persist.
      const em: any = p.error
      const aborted = em?.name === 'MessageAbortedError'
      const msg = String(em?.data?.message ?? em?.message ?? em?.name ?? 'error')
      const cur = tabs.snapshot(sid)
      // server collapses identical (sid,message) — mirror that locally so a
      // duplicate event can't double-render a tile before the next reload
      const errors = [...(cur?.errors ?? [])]
      if (!aborted && !errors.some((e) => e.message === msg)) errors.push({ message: msg, t: Date.now() })
      tabs.patch(sid, { busy: false, errors })
      if (!aborted) hist.addSessionError(sid, msg) // persist fire-and-forget
      // transient provider failure (APIError + isRetryable) → auto-retry the
      // failed turn's prompt with backoff (5s → 15s → 30s → 60s → 2m → 5m)
      if (isRetryableError(em)) scheduleRetry(sid)
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
      const tally = tokenTally(p.info.tokens)
      if (tally !== undefined) patchMetrics(sid, { tokens: tally })
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
    // EventSource auto-reconnects; re-pull permissions AND pending questions —
    // a question.asked during a dropout is otherwise lost until reload
    // (GET /question is not replayed on reconnect)
    setTimeout(() => {
      refreshPermissions()
      refreshQuestions()
    }, 1500)
  }
}
