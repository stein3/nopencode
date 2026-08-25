<script lang="ts">
  import { onMount } from 'svelte'
  import { oc, hist, type HistSession, type SearchHit } from '../lib/api'
  import { searchQuery, sessionMetrics, permissions, tabs, sessionUnread, markSessionUnread, hideSubagents, subExpanded } from '../lib/stores'
  import { relTime } from '../lib/util'

  export let onOpenHistory: (id: string, anchor?: string) => void
  export let onNewChat: () => void

  let sessions: HistSession[] = []
  let hits: SearchHit[] = []
  let searching = false
  let searchTimer: ReturnType<typeof setTimeout>

  // live busy state from engine /oc/session/status
  let busyMap: Record<string, boolean> = {}

  async function refreshBusy() {
    try {
      const st = await oc.status()
      const next: Record<string, boolean> = {}
      for (const [k, v] of Object.entries(st)) {
        next[k] = (v?.type ?? v?.state) === 'busy'
      }
      // busy→idle for sessions with no open tab never reaches the SSE handler
      // (it drops non-open sessions) — detect the transition here instead
      for (const [sid, busy] of Object.entries(busyMap)) {
        if (busy && !next[sid] && !tabs.isopen(sid)) markSessionUnread(sid)
      }
      // assign only on actual change — a fresh object every tick would
      // invalidate every row binding (re-diff of the whole list) each poll
      const prev = busyMap
      const changed =
        Object.keys(prev).length !== Object.keys(next).length ||
        Object.keys(next).some((k) => !!prev[k] !== !!next[k])
      if (changed) busyMap = next
    } catch {
      /* engine down */
    }
  }

  // set of sessionIDs that have a pending permission request
  $: permSet = new Set($permissions.map((p) => p.sessionID).filter((x): x is string => !!x))

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
    refreshBusy()
    const iv = setInterval(load, 60000)
    const ivBusy = setInterval(refreshBusy, 10000)
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        load()
        refreshBusy()
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      clearInterval(iv)
      clearInterval(ivBusy)
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
          // live SSE tally wins; fall back to the sqlite snapshot instead of
          // hiding the row's tokens while no positive reading exists yet
          tokens: m.tokens ?? s.tokens,
        }
      })
      .sort((a, b) => b.updated - a.updated)
  }

  // ---- subagent sessions (@explore / @general / …) -------------------------
  // Engine marks them with a parentID; titles carry a redundant
  // " (@explore subagent)" suffix that the badge replaces.
  const SUB_SUFFIX = /\s*\(@\S+ subagent\)\s*$/

  function isSub(s: Row): boolean {
    return !!s.parent
  }

  function subLabel(s: Row): string {
    return s.agent ? `@${s.agent}` : '@sub'
  }

  function displayTitle(s: Row): string {
    if (!isSub(s)) return s.title || s.id.slice(0, 14)
    const t = (s.title || '').replace(SUB_SUFFIX, '').trim()
    return t || s.id.slice(0, 14)
  }

  $: subCount = rows.filter(isSub).length
  $: visible = $hideSubagents ? rows.filter((s) => !isSub(s)) : rows

  // ---- nesting: subagent sessions grouped under their parent ---------------
  // rows are already sorted updated-desc; groups preserve that order. A sub
  // whose parent is missing from the list (deleted session) stays top-level.
  const MAX_DEPTH = 2

  interface Disp {
    s: Row
    depth: number
    kids: number
    expanded: boolean
    agg: { busy: boolean; perm: boolean; unread: boolean }
  }

  $: idSet = new Set(rows.map((r) => r.id))
  $: kidsMap = (() => {
    const m = new Map<string, Row[]>()
    for (const r of rows) {
      if (!r.parent || !idSet.has(r.parent)) continue
      const arr = m.get(r.parent)
      if (arr) arr.push(r)
      else m.set(r.parent, [r])
    }
    return m
  })()
  $: roots = rows.filter((r) => !r.parent || !idSet.has(r.parent))
  $: nestedCount = rows.length - roots.length

  function descIds(kids: Row[], map: Map<string, Row[]>): string[] {
    const out: string[] = []
    const stack = [...kids]
    for (let i = 0; i < stack.length; i++) {
      const r = stack[i]
      out.push(r.id)
      const k = map.get(r.id)
      if (k) stack.push(...k)
    }
    return out
  }

  function flattenTree(
    roots: Row[],
    map: Map<string, Row[]>,
    expandedSet: Set<string>,
    busy: Record<string, boolean>,
    perms: Set<string>,
    unread: Set<string>,
  ): Disp[] {
    const out: Disp[] = []
    const statusOf = (ids: string[]) => {
      const a = { busy: false, perm: false, unread: false }
      for (const id of ids) {
        if (busy[id]) a.busy = true
        if (perms.has(id)) a.perm = true
        if (unread.has(id)) a.unread = true
      }
      return a
    }
    const walk = (r: Row, depth: number) => {
      const kids = map.get(r.id) ?? []
      const expanded = expandedSet.has(r.id)
      out.push({ s: r, depth, kids: kids.length, expanded, agg: statusOf(descIds(kids, map)) })
      // depth cap: deeper generations stay behind their (counted) chevron
      if (kids.length && expanded && depth < MAX_DEPTH) for (const k of kids) walk(k, depth + 1)
    }
    for (const r of roots) walk(r, 0)
    return out
  }

  const flat = (s: Row): Disp => ({ s, depth: 0, kids: 0, expanded: false, agg: { busy: false, perm: false, unread: false } })

  // re-runs on rows / collapse state / any per-session status change
  $: displayRows = $hideSubagents
    ? visible.map(flat)
    : flattenTree(roots, kidsMap, $subExpanded, busyMap, permSet, $sessionUnread)
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
      <div class="section">
        <span class="count"
          >{#if $hideSubagents}Sessions ({visible.length}
              <span class="hidcount">· {subCount} hidden</span>)
            {:else}Sessions ({roots.length}{nestedCount
              ? ` · ${nestedCount} nested`
              : ''}){/if}</span
        >
        <label class="hidesub" title="Show or hide subagent sessions (@explore, @general, …)">
          <input type="checkbox" bind:checked={$hideSubagents} /> hide subagents
        </label>
      </div>
      {#each displayRows as d (d.s.id)}
        <button
          class="item"
          class:sub-row={isSub(d.s)}
          class:child={d.depth > 0}
          style="--depth: {d.depth}"
          on:click={() => onOpenHistory(d.s.id)}
          title={d.s.title}
        >
          <span class="row1">
            <span class="title">
              <span
                class="dot"
                class:unread={$sessionUnread.has(d.s.id)}
                class:busy={busyMap[d.s.id]}
                class:perm={permSet.has(d.s.id)}
              ></span>
              {#if d.kids && d.depth < MAX_DEPTH}
                <span
                  class="chev"
                  title={d.expanded ? 'Collapse subagents' : 'Expand subagents'}
                  role="button"
                  tabindex="-1"
                  on:click|stopPropagation={() => subExpanded.toggle(d.s.id)}
                  on:keydown|stopPropagation={(e) =>
                    e.key === 'Enter' && subExpanded.toggle(d.s.id)}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 8 8"
                    style:transform={d.expanded ? 'rotate(90deg)' : 'none'}
                  >
                    <path d="M2 1 L6.5 4 L2 7 Z" fill="currentColor" />
                  </svg>
                </span>
              {/if}
              {displayTitle(d.s)}
              {#if d.kids}<span class="kidcount">{d.kids}</span>{/if}
              {#if d.kids && !d.expanded}
                {#if d.agg.perm}<span class="aggdot perm" title="a subagent needs permission"></span>
                {:else if d.agg.busy}<span class="aggdot busy" title="a subagent is running"></span>
                {:else if d.agg.unread}<span class="aggdot unread" title="a subagent finished"></span>{/if}
              {/if}
            </span>
            <span class="meta">{relTime(d.s.updated)}</span>
          </span>
          <span class="sub"
            >{#if isSub(d.s)}<span class="subagent">{subLabel(d.s)}</span> · {/if}{d.s.message_count} msgs{fmtK(
                d.s.tokens
              )
                ? ` · ${fmtK(d.s.tokens)} tk`
                : ''}{d.s.model ? ` · ${d.s.model}` : ''}</span
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
  @supports (height: 100dvh) {
    .sidebar {
      height: var(--vvh, 100dvh);
    }
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
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    row-gap: 2px;
  }
  .count {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .hidesub {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    text-transform: none;
    letter-spacing: 0;
    font-size: 11px;
    color: var(--fg-dim);
    cursor: pointer;
    user-select: none;
  }
  .hidesub input {
    accent-color: var(--accent);
    margin: 0;
  }
  .hidesub:hover {
    color: var(--fg);
  }
  .hidcount {
    opacity: 0.7;
    text-transform: none;
    letter-spacing: 0;
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
    padding-left: calc(12px + var(--depth, 0) * 16px);
    cursor: pointer;
    font-size: 12.5px;
    position: relative;
  }
  .item:hover {
    background: var(--bg-hover);
    border-left-color: var(--accent);
  }
  /* tree guide line for nested rows, drawn in the parent's indent gutter */
  .item.child::before {
    content: '';
    position: absolute;
    left: calc(12px + (var(--depth) - 1) * 16px + 8px);
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--border);
    pointer-events: none;
  }
  .chev {
    flex: none;
    width: 16px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--fg-dim);
    cursor: pointer;
    user-select: none;
  }
  .chev svg {
    display: block;
  }
  .chev:hover {
    color: var(--fg);
  }
  .kidcount {
    flex: none;
    font-size: 9.5px;
    font-weight: 600;
    color: var(--fg-dim);
    background: var(--bg-hover);
    border-radius: 8px;
    padding: 0 5px;
    line-height: 1.5;
  }
  /* aggregated descendant status on a collapsed parent — solid, no animation */
  .aggdot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }
  .aggdot.busy {
    background: var(--warn);
  }
  .aggdot.perm {
    background: var(--err);
  }
  .aggdot.unread {
    background: var(--accent);
    opacity: 0.7;
  }
  .row1 {
    display: flex;
    justify-content: space-between;
    gap: 8px;
  }
  .title {
    display: flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
    background: transparent;
  }
  .dot.unread {
    background: var(--accent);
  }
  .dot.busy {
    background: var(--warn);
  }
  .dot.perm {
    background: var(--err);
  }
  .meta,
  .sub {
    color: var(--fg-dim);
    font-size: 11.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .item.sub-row .title {
    opacity: 0.85;
  }
  .subagent {
    color: #ec7ba4;
    font-weight: 600;
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
