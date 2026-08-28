<script lang="ts">
  import { onMount } from 'svelte'
  import { oc, hist, type HistSession } from '../lib/api'
  import { RECENT_PAGE } from '../lib/sse'
  import {
    selectedModel,
    sessionTodos,
    sessionMetrics,
    sessionKidMap,
    metricsFromMessages,
    permissions,
    pendingQuestions,
    sessionUnread,
    sessionListDirty,
  } from '../lib/stores'
  import { relTime } from '../lib/util'
  import type { Tab } from '../lib/stores'

  export let tab: Tab | null
  // linked-session rows open the child session (App wires this to openHistory)
  export let onOpen: ((id: string) => void) | undefined = undefined

  let cost = 0
  // live SSE tallies (sessionMetrics) take precedence; fetchedTokens seeds
  // sessions with no SSE traffic yet. See tokenTally for why zero tallies are
  // skipped instead of shown as "0 context".
  let fetchedTokens = 0
  let limit = 0
  let fetchedTodos: any[] = []

  function fmtK(n: number): string {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
    if (n >= 1000) return Math.round(n / 1000) + 'K'
    return String(n)
  }

  function clearVals() {
    cost = 0
    fetchedTokens = 0
    fetchedTodos = []
  }

  const keyOf = (t: Tab | null) => `${t?.id ?? ''}:${t?.busy ? 1 : 0}`

  async function refresh() {
    const cur = tab
    if (!cur?.id || !cur.live || cur.pending) {
      // pure-history snapshot or not created on the engine yet: no data
      clearVals()
      return
    }
    const myKey = keyOf(cur)
    try {
      const [sess, msgs, td] = await Promise.all([
        oc.session(cur.id),
        oc.messages(cur.id, RECENT_PAGE),
        oc.todos(cur.id),
      ])
      // discard a stale response if the panel switched sessions meanwhile
      if (keyOf(tab) !== myKey) return
      cost = sess?.cost ?? 0
      fetchedTodos = Array.isArray(td) ? td : []
      fetchedTokens = metricsFromMessages(msgs ?? []).tokens ?? 0
    } catch {
      /* keep previous values */
    }
  }

  let lastKey = ''
  let lastId = ''
  $: key = keyOf(tab)
  $: if (key !== lastKey) {
    // switching sessions: drop the previous session's numbers/todos instead of
    // flashing them while the new fetch is in flight
    if ((tab?.id ?? '') !== lastId) {
      lastId = tab?.id ?? ''
      clearVals()
    }
    lastKey = key
    refresh()
  }
  // live updates from todo.updated events, fetch as initial/fallback source
  $: todos = $sessionTodos[tab?.id ?? ''] ?? fetchedTodos
  // safety net: slow poll in case events are missed (e.g. reconnect gaps);
  // also re-pulls the linked-sessions list + busy states at the same cadence
  onMount(() => {
    const iv = setInterval(() => {
      refresh()
      refreshLinked()
    }, 30000)
    return () => { clearInterval(iv); clearTimeout(linkedDirtyTimer) }
  })
  $: limit = getContextLimit($selectedModel)

  function getContextLimit(m: { providerID?: string; modelID?: string } | null): number {
    // providers fetched lazily via store subscription below; kept simple here
    return cachedLimit(m)
  }

  let provCache: any[] | null = null
  async function ensureProv() {
    if (!provCache) provCache = await oc.providers().catch(() => [])
  }
  function cachedLimit(m: any): number {
    if (!m || !provCache) return 0
    return provCache.find((p: any) => p.id === m.providerID)?.models?.[m.modelID]?.limit?.context ?? 0
  }
  ensureProv().then(() => (limit = cachedLimit($selectedModel)))

  // live tallies stream in via SSE (message.updated → sessionMetrics) and
  // update DURING a turn; the keyed/interval refresh above only seeds values.
  // Rolled-up tokens: sum of descendant sessions' tokens (subagents).
  $: ownTokens = (tab?.live ? $sessionMetrics[tab.id]?.tokens : undefined) ?? fetchedTokens
  $: rolledUpTokens = (() => {
    const kidList = $sessionKidMap.get(tab?.id ?? '')
    if (!kidList) return 0
    let sum = 0
    for (const kid of kidList) {
      sum += $sessionMetrics[kid.id]?.tokens ?? kid.tokens ?? 0
    }
    return sum
  })()
  $: usedTokens = ownTokens + rolledUpTokens
  $: pct = limit ? Math.min(100, (usedTokens / limit) * 100) : 0
  // rolled-up cost from linked HistSession children (fetched via refreshLinked)
  $: rolledUpCost = kids.reduce((s, k) => s + (k.cost ?? 0), 0)

  // ---- linked sessions: DIRECT children of the active session --------------
  // Same title-suffix convention as the Sidebar (badge replaces "(@… subagent)").
  const SUB_SUFFIX = /\s*\(@\S+ subagent\)\s*$/

  let kids: HistSession[] = []
  let busyKids: Record<string, boolean> = {}
  let parentSession: HistSession | null = null

  function kidTitle(s: HistSession): string {
    if (!s.parent) return s.title || s.id.slice(0, 14)
    const t = (s.title || '').replace(SUB_SUFFIX, '').trim()
    return t || s.id.slice(0, 14)
  }
  function kidLabel(s: HistSession): string {
    return s.agent ? `@${s.agent}` : '@sub'
  }

  function clearLinked() {
    kids = []
    busyKids = {}
    parentSession = null
  }

  async function refreshLinked() {
    const cur = tab?.id
    if (!cur || cur.startsWith('pending-')) {
      clearLinked()
      return
    }
    try {
      const all = await hist.sessions()
      if ((tab?.id ?? '') !== cur) return // panel switched sessions meanwhile
      kids = all.filter((s) => s.parent === cur).sort((a, b) => b.updated - a.updated)
      const curSess = all.find((s) => s.id === cur)
      parentSession = curSess?.parent ? all.find((s) => s.id === curSess.parent) ?? null : null
    } catch {
      /* keep previous list */
    }
    try {
      const st = await oc.status()
      if ((tab?.id ?? '') !== cur) return
      const next: Record<string, boolean> = {}
      for (const [k, v] of Object.entries(st)) next[k] = (v?.type ?? v?.state) === 'busy'
      busyKids = next
    } catch {
      /* engine down — dots just never show busy */
    }
  }

  let lastLinkId = ''
  $: linkId = tab?.id ?? ''
  $: if (linkId !== lastLinkId) {
    lastLinkId = linkId
    clearLinked()
    refreshLinked()
  }

  let linkedDirtyTimer: ReturnType<typeof setTimeout> | undefined
  $: if ($sessionListDirty > 0 && !linkedDirtyTimer) {
    linkedDirtyTimer = setTimeout(() => {
      linkedDirtyTimer = undefined
      refreshLinked()
    }, 250)
  }

  // dot precedence perm > ask > busy > unread — resolved per row here so the
  // derivation reads every store directly (template reactivity gotcha: reads
  // hidden behind method calls are invisible to the compiler)
  $: kidRows = kids.map((c) => ({
    s: c,
    dot: $permissions.some((p) => p.sessionID === c.id)
      ? 'perm'
      : $pendingQuestions.some((q) => q.sessionID === c.id)
        ? 'ask'
        : busyKids[c.id]
          ? 'busy'
          : $sessionUnread.has(c.id)
            ? 'unread'
            : '',
  }))

  $: parentRow = parentSession
    ? {
        s: parentSession,
        dot: $permissions.some((p) => p.sessionID === parentSession!.id)
          ? 'perm'
          : $pendingQuestions.some((q) => q.sessionID === parentSession!.id)
            ? 'ask'
            : busyKids[parentSession!.id]
              ? 'busy'
              : $sessionUnread.has(parentSession!.id)
                ? 'unread'
                : '',
      }
    : null

  const statusIcon: Record<string, string> = {
    completed: '☑',
    in_progress: '◐',
    pending: '☐',
    cancelled: '☒',
  }
</script>

<aside class="info">
  <div class="head">
    <span class="ttl" title={tab?.title}>{tab?.title ?? 'no session'}</span>
    {#if tab?.id}
      <span class="sid">{tab.id}</span>
    {/if}
  </div>

  <div class="sec">Context</div>
  <div class="grid">
    <span class="k">tokens</span><span class="v">{ownTokens ? fmtK(ownTokens) : '—'}</span>
    <span class="k">used</span>
    <span class="v">
      {#if limit}
        <span class="bar"><i style:width={`${pct}%`}></i></span> {pct.toFixed(0)}%
      {:else}
        —
      {/if}
    </span>
    <span class="k">spent</span><span class="v">${cost.toFixed(4)}</span>
    {#if rolledUpTokens || rolledUpCost}
      <span class="k dim">subagents</span><span class="v dim">{fmtK(rolledUpTokens)}</span>
      <span class="k dim">total (tokens)</span><span class="v dim">{fmtK(usedTokens)}</span>
      <span class="k dim">total (spent)</span><span class="v dim">${(cost + rolledUpCost).toFixed(4)}</span>
    {/if}
  </div>

  <div class="sec">Todo</div>
  {#if !todos.length}
    <div class="empty">nothing tracked</div>
  {:else}
    {#each todos as td, i (td.id ?? i)}
      <div class="todo">
        <span class="ic">{statusIcon[td.status] ?? '☐'}</span>
        <span class="t" class:done={td.status === 'completed'}>{td.content ?? td.title ?? td.description ?? '(unnamed)'}</span>
      </div>
    {/each}
  {/if}

  {#if parentRow}
    <div class="sec">Parent Session</div>
    <button class="kid" on:click={() => onOpen?.(parentRow.s.id)} title={parentRow.s.title}>
      <span class="dot {parentRow.dot}"></span>
      <span class="ag">{kidLabel(parentRow.s)}</span>
      <span class="ttext">{kidTitle(parentRow.s)}</span>
      <span class="rt">{relTime(parentRow.s.updated)}</span>
    </button>
  {/if}

  {#if kidRows.length}
    <div class="sec">Linked Sessions</div>
    {#each kidRows as r (r.s.id)}
      <button class="kid" on:click={() => onOpen?.(r.s.id)} title={r.s.title}>
        <span class="dot {r.dot}"></span>
        <span class="ag">{kidLabel(r.s)}</span>
        <span class="ttext">{kidTitle(r.s)}</span>
        <span class="rt">{relTime(r.s.updated)}</span>
      </button>
    {/each}
  {/if}
</aside>

<style>
  .info {
    width: 240px;
    flex-shrink: 0;
    background: var(--bg-panel);
    border-left: 1px solid var(--border);
    padding: 12px;
    overflow-y: auto;
    height: 100vh;
    box-sizing: border-box;
  }
  @supports (height: 100dvh) {
    .info {
      height: var(--vvh, 100dvh);
    }
  }
  .head .ttl {
    font-weight: 600;
    font-size: 13px;
    display: block;
    overflow-wrap: anywhere;
    white-space: normal;
  }
  .head .sid {
    font-size: 10px;
    font-family: var(--mono);
    color: var(--fg-dim);
    display: block;
    margin-top: 2px;
    overflow-wrap: anywhere;
    word-break: break-all;
  }
  .sec {
    margin: 16px 0 6px;
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--fg-dim);
  }
  .grid {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 5px 12px;
    font-size: 12.5px;
  }
  .k {
    color: var(--fg-dim);
  }
  .k.dim {
    color: var(--fg-dim);
    opacity: 0.65;
    font-size: 11px;
  }
  .v.dim {
    opacity: 0.65;
    font-size: 11px;
  }
  .v {
    text-align: right;
    font-family: var(--mono);
    font-size: 11.5px;
  }
  .bar {
    display: inline-block;
    width: 64px;
    height: 6px;
    background: var(--bg-hover);
    border-radius: 3px;
    overflow: hidden;
    vertical-align: middle;
    margin-right: 6px;
  }
  .bar i {
    display: block;
    height: 100%;
    background: var(--accent);
  }
  .empty {
    color: var(--fg-dim);
    font-size: 12px;
    padding: 2px 0;
  }
  .todo {
    display: flex;
    gap: 8px;
    align-items: baseline;
    font-size: 12.5px;
    padding: 3px 0;
  }
  .todo .ic {
    color: var(--accent);
    flex-shrink: 0;
  }
  .todo .t.done {
    text-decoration: line-through;
    color: var(--fg-dim);
  }
  /* linked sessions — solid status dots, no animations (repo rule); scoped
     duplication of Sidebar's dot classes is the repo convention */
  .kid {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: var(--fg);
    padding: 5px 6px;
    cursor: pointer;
    font-family: inherit; /* no global button reset in app.css */
    font-size: 12px;
  }
  .kid:hover {
    background: var(--bg-hover);
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
    background: transparent;
  }
  .dot.unread {
    background: var(--ok);
    opacity: 0.7;
  }
  .dot.busy {
    background: var(--warn);
  }
  /* source order = precedence: perm > ask > busy > unread (mirrors Sidebar) */
  .dot.ask {
    background: var(--err);
  }
  .dot.perm {
    background: var(--err);
  }
  .ag {
    color: #ec7ba4;
    font-weight: 600;
    font-size: 11px;
    flex: none;
  }
  .ttext {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rt {
    color: var(--fg-dim);
    font-size: 10.5px;
    flex: none;
    margin-left: auto;
  }
</style>
