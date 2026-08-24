<script lang="ts">
  import { onMount } from 'svelte'
  import { hist, type HistSession, type SearchHit } from '../lib/api'
  import { searchQuery, sessionMetrics } from '../lib/stores'
  import { relTime } from '../lib/util'

  export let onOpenHistory: (id: string, anchor?: string) => void
  export let onNewChat: () => void

  let sessions: HistSession[] = []
  let hits: SearchHit[] = []
  let searching = false
  let searchTimer: ReturnType<typeof setTimeout>

  $: q = $searchQuery.trim()

  $: if (q.length >= 2) {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(runSearch, 200)
  }

  async function runSearch() {
    searching = true
    try {
      hits = await hist.search(q)
    } finally {
      searching = false
    }
  }

  async function load() {
    try {
      const all = await hist.sessions()
      sessions = all.sort((a, b) => b.updated - a.updated)
    } catch (e) {
      console.error('history load failed', e)
    }
  }
  load()

  // sqlite snapshot only changes on reload — poll so non-open sessions stay
  // roughly fresh too (open tabs are corrected live via sessionMetrics)
  onMount(() => {
    const iv = setInterval(load, 60000)
    const onVis = () => {
      if (document.visibilityState === 'visible') load()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      clearInterval(iv)
      document.removeEventListener('visibilitychange', onVis)
    }
  })

  interface Row extends HistSession {
    tokens?: number
  }

  function fmtK(n?: number): string {
    if (!n) return ''
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
    if (n >= 1000) return Math.round(n / 1000) + 'K'
    return String(n)
  }

  // live metrics for open tabs overlay the snapshot; re-sorted so activity floats up
  $: rows = mergeRows(sessions, $sessionMetrics)

  function mergeRows(list: HistSession[], metrics: Record<string, any>): Row[] {
    return list
      .map((s) => {
        const m = metrics[s.id]
        if (!m) return s as Row
        return {
          ...s,
          updated: m.updated ?? s.updated,
          cost: m.cost ?? s.cost,
          message_count: m.messages ?? s.message_count,
          tokens: m.tokens,
        }
      })
      .sort((a, b) => b.updated - a.updated)
  }
</script>

<aside class="sidebar">
  <div class="top">
    <button class="new" title="New chat (Ctrl+T)" on:click={onNewChat}>＋ New chat</button>
  </div>
  <div class="searchbox">
    <input
      id="sidebar-search"
      placeholder="Search all chats…  (Ctrl+K)"
      bind:value={$searchQuery}
    />
  </div>

  <div class="list">
    {#if q.length >= 2}
      {#if searching}
        <div class="hint">searching…</div>
      {:else}
        <div class="section">Results ({hits.length})</div>
        {#each hits as h (h.part_id)}
          <button class="item" on:click={() => onOpenHistory(h.session_id, h.message_id)}>
            <span class="title">{h.session_title}</span>
            <span class="snippet">{h.snippet}</span>
          </button>
        {:else}
          <div class="hint">no matches</div>
        {/each}
      {/if}
    {:else}
      <div class="section">Sessions ({rows.length})</div>
      {#each rows as s (s.id)}
        <button class="item" on:click={() => onOpenHistory(s.id)} title={s.title}>
          <span class="row1">
            <span class="title">{s.title || s.id.slice(0, 14)}</span>
            <span class="meta">{relTime(s.updated)}</span>
          </span>
          <span class="sub"
            >{s.message_count} msgs{fmtK(s.tokens) ? ` · ${fmtK(s.tokens)} tk` : ''}{s.model
              ? ` · ${s.model}`
              : ''}</span
          >
        </button>
      {:else}
        <div class="hint">loading…</div>
      {/each}
    {/if}
  </div>

  <div class="legend">
    <kbd>Ctrl+K</kbd> search · <kbd>/</kbd> input · <kbd>Ctrl+T/W</kbd> tabs ·
    <kbd>Alt+←→</kbd> cycle
  </div>
</aside>

<style>
  .sidebar {
    display: flex;
    flex-direction: column;
    background: var(--bg-panel);
    border-right: 1px solid var(--border);
    min-width: 260px;
    max-width: 320px;
    height: 100vh;
  }
  .top {
    padding: 10px;
  }
  .new {
    width: 100%;
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: 6px;
    padding: 7px;
    font-size: 13px;
    cursor: pointer;
  }
  .new:hover {
    filter: brightness(1.15);
  }
  .searchbox {
    padding: 0 10px;
  }
  #sidebar-search {
    width: 100%;
    box-sizing: border-box;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 6px 9px;
    font-size: 12.5px;
    outline: none;
  }
  #sidebar-search:focus {
    border-color: var(--accent);
  }
  .list {
    flex: 1;
    overflow-y: auto;
    margin-top: 8px;
  }
  .section {
    padding: 8px 12px 4px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--fg-dim);
  }
  .item {
    display: flex;
    flex-direction: column;
    gap: 3px;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    border-left: 2px solid transparent;
    color: var(--fg);
    padding: 7px 12px;
    cursor: pointer;
    font-size: 12.5px;
  }
  .item:hover {
    background: var(--bg-hover);
    border-left-color: var(--accent);
  }
  .row1 {
    display: flex;
    justify-content: space-between;
    gap: 8px;
  }
  .title {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .meta,
  .sub {
    color: var(--fg-dim);
    font-size: 11.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .snippet {
    color: var(--fg-dim);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  :global(.snippet mark),
  .snippet :global(mark) {
    background: rgba(255, 200, 0, 0.35);
    color: inherit;
    padding: 0;
  }
  .hint {
    padding: 10px 12px;
    color: var(--fg-dim);
    font-size: 12px;
  }
  .legend {
    padding: 8px 12px;
    border-top: 1px solid var(--border);
    color: var(--fg-dim);
    font-size: 11px;
    user-select: none;
  }
  kbd {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0 4px;
    font-size: 10px;
  }
</style>
