<script lang="ts">
  import { onMount } from 'svelte'
  import { oc } from '../lib/api'
  import { selectedModel, sessionTodos } from '../lib/stores'
  import type { Tab } from '../lib/stores'

  export let tab: Tab | null

  let cost = 0
  let usedTokens = 0
  let limit = 0
  let fetchedTodos: any[] = []

  function fmtK(n: number): string {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
    if (n >= 1000) return Math.round(n / 1000) + 'K'
    return String(n)
  }

  function clearVals() {
    cost = 0
    usedTokens = 0
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
        oc.messages(cur.id),
        oc.todos(cur.id),
      ])
      // discard a stale response if the panel switched sessions meanwhile
      if (keyOf(tab) !== myKey) return
      cost = sess?.cost ?? 0
      fetchedTodos = Array.isArray(td) ? td : []
      const withTok = [...(msgs ?? [])]
        .reverse()
        .find((m: any) => ((m.info ?? m)?.role ?? 'assistant') === 'assistant' && (m.info ?? m)?.tokens)
      const tk = withTok ? ((withTok.info ?? withTok).tokens ?? {}) : {}
      usedTokens =
        (tk.input ?? 0) + (tk.output ?? 0) + (tk.reasoning ?? 0) +
        ((tk.cache?.read ?? 0) + (tk.cache?.write ?? 0))
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
  // safety net: slow poll in case events are missed (e.g. reconnect gaps)
  onMount(() => {
    const iv = setInterval(() => refresh(), 30000)
    return () => clearInterval(iv)
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

  $: pct = limit ? Math.min(100, (usedTokens / limit) * 100) : 0

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
  </div>

  <div class="sec">Context</div>
  <div class="grid">
    <span class="k">tokens</span><span class="v">{usedTokens ? fmtK(usedTokens) : '—'}</span>
    <span class="k">used</span>
    <span class="v">
      {#if limit}
        <span class="bar"><i style:width={`${pct}%`}></i></span> {pct.toFixed(0)}%
      {:else}
        —
      {/if}
    </span>
    <span class="k">spent</span><span class="v">${cost.toFixed(4)}</span>
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
  .head .ttl {
    font-weight: 600;
    font-size: 13px;
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
</style>
