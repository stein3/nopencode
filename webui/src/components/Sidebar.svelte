<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { oc, hist, type HistSession, type SearchHit } from '../lib/api'
  import { searchQuery, sessionMetrics, permissions, pendingQuestions, tabs, sessionUnread, markSessionUnread, hideSubagents, subExpanded, settingsOpen, sessionListDirty } from '../lib/stores'
  import { relTime } from '../lib/util'

  const activeStore = tabs.active

  export let onOpenHistory: (id: string, anchor?: string) => void
  export let onNewChat: () => void

  let sessions: HistSession[] = []
  let hits: SearchHit[] = []
  let searching = false
  let searchTimer: ReturnType<typeof setTimeout>
  let searchEl: HTMLInputElement

  function clearSearch() {
    searchQuery.set('')
    hits = []
    groups = []
    searchEl?.blur()
  }

  function onSearchKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      clearSearch()
    }
  }

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

  // set of sessionIDs with a pending engine question-tool request — red dot
  // like permissions (the engine holds the turn busy until it's answered)
  $: qSet = new Set($pendingQuestions.map((q) => q.sessionID).filter((x): x is string => !!x))

  $: q = $searchQuery.trim()

  // Parse filter tokens like "title:foo agent:bar" from the query.
  // The remaining text (no filter prefix) becomes the free-text search term.
  $: parsedSearch = parseSearchQuery(q)
  $: searchText = parsedSearch.free
  $: searchFilters = parsedSearch.filters

  interface SearchFilter {
    key: string
    value: string
  }

  function parseSearchQuery(raw: string): { free: string; filters: SearchFilter[] } {
    const filters: SearchFilter[] = []
    // match key:value or key:"value with spaces"
    const re = /\b(title|role):(?:"([^"]*)"|(\S+))/gi
    let free = raw
    let m: RegExpExecArray | null
    while ((m = re.exec(raw))) {
      filters.push({ key: m[1].toLowerCase(), value: (m[2] ?? m[3]).toLowerCase() })
      free = free.slice(0, m.index) + free.slice(m.index + m[0].length)
    }
    free = free.trim()
    return { free, filters }
  }

  $: if (searchText.length >= 2 || (searchFilters.length && q.length >= 2)) {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(runSearch, 200)
  }

  async function runSearch() {
    searching = true
    try {
      // When only filters are present (no free text), use the sessions API
      // and apply filters client-side — avoids FTS highlighting filter keywords
      if (searchFilters.length && !searchText) {
        const sessions = await hist.sessions()
        hits = sessions.map((s) => ({
          session_id: s.id,
          session_title: s.title,
          message_id: '',
          part_id: '',
          role: '',
          time: s.updated,
          snippet: '',
          agent: s.agent,
        }))
        hits = applyFilters(hits, searchFilters)
        groups = groupHits(hits)
        return
      }
      // Use the free-text portion for the API call (FTS);
      // filter tokens are applied client-side after results arrive.
      const apiQuery = searchText || q
      const raw = apiQuery.length >= 2 ? await hist.search(apiQuery) : []
      hits = applyFilters(raw, searchFilters)
      groups = groupHits(hits)
    } finally {
      searching = false
    }
  }

  function applyFilters(raw: SearchHit[], filters: SearchFilter[]): SearchHit[] {
    if (!filters.length) return raw
    return raw.filter((h) => {
      for (const f of filters) {
        if (f.key === 'title' && !h.session_title.toLowerCase().includes(f.value)) return false
        if (f.key === 'role' && h.role?.toLowerCase() !== f.value) return false
        if (f.key === 'agent' && h.agent?.toLowerCase() !== f.value) return false
      }
      return true
    })
  }

  // search results grouped per session; sessions ordered by their most recent
  // match (server returns global time-desc, so re-sort within each group asc)
  interface SearchGroup {
    session_id: string
    title: string
    latest: number
    hits: SearchHit[]
  }

  let groups: SearchGroup[] = []

  function groupHits(list: SearchHit[]): SearchGroup[] {
    const bySid = new Map<string, SearchGroup>()
    for (const h of list) {
      let g = bySid.get(h.session_id)
      if (!g) {
        g = { session_id: h.session_id, title: h.session_title, latest: h.time, hits: [] }
        bySid.set(h.session_id, g)
      }
      if (h.time > g.latest) g.latest = h.time
      g.hits.push(h)
    }
    const out = [...bySid.values()]
    for (const g of out) g.hits.sort((a, b) => a.time - b.time)
    return out.sort((a, b) => b.latest - a.latest)
  }

  // split a server snippet into plain/highlighted segments; snippets carry
  // \x00/\x01 sentinels around each case-insensitive match occurrence.
  // Toggle-based scan drops the sentinel chars; stray/unterminated markers
  // degrade harmlessly instead of rendering as text.
  function snipSegs(s: string): { t: string; hl: boolean }[] {
    const segs: { t: string; hl: boolean }[] = []
    let hl = false
    let buf = ''
    for (const ch of s) {
      if (ch === '\x00') {
        if (buf) segs.push({ t: buf, hl })
        buf = ''
        hl = true
      } else if (ch === '\x01') {
        if (buf) segs.push({ t: buf, hl })
        buf = ''
        hl = false
      } else {
        buf += ch
      }
    }
    if (buf) segs.push({ t: buf, hl })
    return segs
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

  // instant reload when any code path bumps the dirty signal (create, rename,
  // cross-client SSE title change) — complements the 60 s safety-net poll
  $: if ($sessionListDirty > 0) load()

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
    // hide-mode rows: sub rows aren't rendered, but kids/agg still carry the
    // aggregated descendant state so the light stays visible (count/chev don't)
    subsHidden?: boolean
    agg: { busy: boolean; perm: boolean; ask: boolean; unread: boolean }
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
    asks: Set<string>,
    unread: Set<string>,
  ): Disp[] {
    const out: Disp[] = []
    const statusOf = (ids: string[]) => {
      const a = { busy: false, perm: false, ask: false, unread: false }
      for (const id of ids) {
        if (busy[id]) a.busy = true
        if (perms.has(id)) a.perm = true
        if (asks.has(id)) a.ask = true
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

  // hide-mode expand set: nothing expands (sub rows aren't rendered anyway)
  const NO_EXPAND = new Set<string>()

  // re-runs on rows / collapse state / any per-session status change.
  // Hidden mode still flattens to aggregate descendant status into kids/agg,
  // but keeps only root rows flagged subsHidden — the template then drops the
  // chevron + count while keeping the aggregated light. $hideSubagents must be
  // read directly here (template reactivity gotcha — it is).
  $: displayRows = $hideSubagents
    ? flattenTree(visible, kidsMap, NO_EXPAND, busyMap, permSet, qSet, $sessionUnread)
        .filter((d) => d.depth === 0)
        .map((d) => ({ ...d, subsHidden: true }))
    : flattenTree(roots, kidsMap, $subExpanded, busyMap, permSet, qSet, $sessionUnread)

  // ---- session list keyboard navigation (Alt+Up/Down) ----------------------
  // navOrder is a snapshot of session IDs taken on the first Alt+press; it
  // freezes the sort order so the focus row doesn't jump while navigating.
  // Cleared after 3 s of inactivity (auto-unlock) or on Escape / click.
  let focusedId: string | null = null
  let navOrder: string[] | null = null
  let navTimer: ReturnType<typeof setTimeout> | undefined

  export function navSession(dir: 1 | -1) {
    const visible = new Set(displayRows.map((d) => d.s.id))
    if (!visible.size) return

    // break focus on the composer so Enter/Escape fall through to the
    // nav key handler instead of typing into the input
    const el = document.activeElement as HTMLElement | null
    if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable)) {
      el.blur()
    }

    // first press: snapshot the current display order
    if (!navOrder) navOrder = displayRows.map((d) => d.s.id)

    // if the previously focused session disappeared (deleted / filtered out),
    // re-anchor at the same positional index (clamped to nearest visible)
    if (focusedId && !visible.has(focusedId)) {
      const oldIdx = navOrder.indexOf(focusedId)
      if (oldIdx >= 0) {
        focusedId = scanVisible(navOrder, oldIdx, dir, visible)
      } else {
        focusedId = null
      }
    }

    if (!focusedId) {
      // initialise from the active tab's position (most recent anchor),
      // or its parent if it's a hidden subagent, or top/bottom as last resort
      let anchor: string | null = $activeStore
      if (anchor && !visible.has(anchor)) {
        const s = sessions.find((x) => x.id === anchor)
        if (s?.parent && visible.has(s.parent)) anchor = s.parent
        else anchor = null
      }
      const start = anchor != null ? navOrder.indexOf(anchor) : dir === 1 ? 0 : navOrder.length - 1
      focusedId = scanVisible(navOrder, start, dir, visible)
    } else {
      const cur = navOrder.indexOf(focusedId)
      const next = ((cur + dir) % navOrder.length + navOrder.length) % navOrder.length
      focusedId = scanVisible(navOrder, next, dir, visible)
    }

    if (!focusedId) {
      navClear()
      return
    }

    // reset auto-unlock timer
    clearTimeout(navTimer)
    navTimer = setTimeout(() => {
      navOrder = null
      focusedId = null
    }, 3000)

    // scroll the focused row into view after the DOM updates
    tick().then(() => {
      document.querySelector('.item.nav-focused')?.scrollIntoView({ block: 'nearest' })
    })
  }

  // walk forward (or backward) through `order` from `start`, returning the
  // first entry that exists in `visible`.  Stops after a full revolution.
  function scanVisible(
    order: string[],
    start: number,
    dir: 1 | -1,
    visible: Set<string>,
  ): string | null {
    const len = order.length
    let idx = ((start % len) + len) % len
    for (let i = 0; i < len; i++) {
      if (visible.has(order[idx])) return order[idx]
      idx = ((idx + dir) % len + len) % len
    }
    return null
  }

  export function navOpen() {
    if (focusedId) {
      onOpenHistory(focusedId)
      navClear()
    }
  }

  export function navClear() {
    focusedId = null
    navOrder = null
    clearTimeout(navTimer)
  }

  function onNavKey(e: KeyboardEvent) {
    if (!focusedId) return
    // don't hijack keys while the user is typing in an input
    const el = e.target as HTMLElement | null
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
    if (e.key === 'Enter') {
      e.preventDefault()
      navOpen()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      navClear()
    }
  }
</script>

<svelte:window on:keydown={onNavKey} />

<aside class="sidebar">
  <div class="top">
    <button class="gear" title="Settings" aria-label="Settings" on:click={() => settingsOpen.set(true)}>
      <!-- inline gear (no external icon assets) -->
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3" />
        <path
          d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
        />
      </svg>
    </button>
    <button class="new" title="New chat (Ctrl+T)" on:click={onNewChat}>＋ New chat</button>
  </div>
  <div class="searchbox">
    <div class="searchwrap">
      <input
        id="sidebar-search"
        placeholder="Search all chats…  (Ctrl+K)"
        bind:value={$searchQuery}
        bind:this={searchEl}
        on:keydown={onSearchKey}
      />
      {#if $searchQuery}
        <button class="searchclear" title="Clear search (Esc)" on:click={clearSearch}>×</button>
      {/if}
    </div>
    {#if $searchQuery}
      <div class="searchhint">
        <span class="fhint">Filters: title: role:</span>
      </div>
    {/if}
  </div>

  <div class="list" class:flat={$hideSubagents}>
    {#if q.length >= 2}
      {#if searching}
        <div class="hint">searching…</div>
      {:else}
        <div class="section">Results ({hits.length} in {groups.length} chats)</div>
        {#each groups as g (g.session_id)}
          <div class="grphead" class:current={g.session_id === $activeStore}>
            <span class="title">{g.title}</span>
            <span class="meta">{relTime(g.latest)}</span>
          </div>
          {#each g.hits as h (h.part_id)}
            <button class="item hit" on:click={() => onOpenHistory(h.session_id, h.message_id)}>
              <span class="snippet"
                >{#each snipSegs(h.snippet) as seg}<span class:hl={seg.hl}>{seg.t}</span>{/each}</span
              >
            </button>
          {/each}
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
          class:current={d.s.id === $activeStore}
          class:nav-focused={d.s.id === focusedId}
          style="--depth: {d.depth}"
          on:click={() => { navClear(); onOpenHistory(d.s.id) }}
          title={d.s.title}
        >
          <span class="row1">
            <span class="title">
              {#if d.kids && d.depth < MAX_DEPTH && !d.subsHidden}
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
              {:else}
                <!-- reserved chevron column: rows without an expander keep the
                     same left rhythm, so status lights align down the list -->
                <span class="chevslot"></span>
              {/if}
              <span
                class="dot"
                class:unread={$sessionUnread.has(d.s.id)}
                class:busy={busyMap[d.s.id]}
                class:ask={qSet.has(d.s.id)}
                class:perm={permSet.has(d.s.id)}
                title={permSet.has(d.s.id)
                  ? 'permission needed'
                  : qSet.has(d.s.id)
                    ? 'question needs an answer'
                    : busyMap[d.s.id]
                      ? 'running'
                      : $sessionUnread.has(d.s.id)
                        ? 'unread'
                        : undefined}
              ></span>
              <span class="ttext">{displayTitle(d.s)}</span>
              <!-- aggregated descendant status on collapsed parents (or any
                   parent in hide mode): LINE 1's right side, immediately
                   before the subagent counter chip -->
              {#if d.kids && (d.subsHidden || !d.expanded)}
                {#if d.agg.perm}<span class="aggdot perm" title="a subagent needs permission"></span>
                {:else if d.agg.ask}<span class="aggdot ask" title="a subagent needs an answer"></span>
                {:else if d.agg.busy}<span class="aggdot busy" title="a subagent is running"></span>
                {:else if d.agg.unread}<span class="aggdot unread" title="a subagent finished"></span>{/if}
              {/if}
              <!-- counter always renders, even hide mode; only the chevron is
                   gated off there -->
              {#if d.kids}
                <span class="kidcount" title={`${d.kids} subagent${d.kids === 1 ? '' : 's'}${d.subsHidden ? ' · hidden' : ''}`}
                  >{d.kids}</span
                >
              {/if}
            </span>
          </span>
          <span class="sub"
            ><span
                class="smeta"
              >{#if isSub(d.s)}<span class="subagent">{subLabel(d.s)}</span> · {/if}{d.s.message_count} msgs{fmtK(
                  d.s.tokens
                )
                ? ` · ${fmtK(d.s.tokens)} tk`
                : ''}{d.s.model ? ` · ${d.s.model}` : ''}</span
            >
            <span class="stime" title={new Date(d.s.updated).toLocaleString()}>{relTime(d.s.updated)}</span>
          </span>
        </button>
      {:else}
        <div class="hint">loading…</div>
      {/each}
    {/if}
  </div>

  <div class="legend">
    <kbd>Ctrl+K</kbd> search · <kbd>/</kbd> input · <kbd>Ctrl+T/W</kbd> tabs ·
    <kbd>Alt+←→</kbd> cycle · <kbd>Alt+↑↓</kbd> sessions
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
    /* session-row column tokens — line 1's leading prefix AND line 2's meta
       indent are built from these same values so the two lines cannot drift */
    --chevw: 16px; /* chevron / reserved-slot column */
    --dotw: 7px;   /* status light */
    --aggw: 6px;   /* aggregated-subagent light */
    --rowgap: 6px; /* gap between the leading columns */
    --rowpad: 6px; /* row LEFT padding (chevron x = border 2px + this) */
  }
  @supports (height: 100dvh) {
    .sidebar {
      height: var(--vvh, 100dvh);
    }
  }
  .top {
    padding: 10px;
    display: flex;
    gap: 8px;
  }
  .new {
    flex: 1;
    min-width: 0;
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
  /* square icon button, same tokens as the topbar's burger buttons */
  .gear {
    flex: none;
    width: 34px;
    align-self: stretch;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--fg-dim);
    cursor: pointer;
    padding: 0;
  }
  .gear:hover {
    color: var(--fg);
    border-color: var(--accent);
  }
  .gear svg {
    display: block;
  }
  .searchbox {
    padding: 0 10px;
  }
  .searchwrap {
    position: relative;
  }
  #sidebar-search {
    width: 100%;
    box-sizing: border-box;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 6px 9px;
    padding-right: 28px;
    font-size: 12.5px;
    outline: none;
  }
  #sidebar-search:focus {
    border-color: var(--accent);
  }
  .searchclear {
    position: absolute;
    right: 4px;
    top: 50%;
    transform: translateY(-50%);
    width: 22px;
    height: 22px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--fg-dim);
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
  }
  .searchclear:hover {
    background: var(--bg-hover);
    color: var(--fg);
  }
  .searchhint {
    padding: 3px 0 0;
    font-size: 10.5px;
    color: var(--fg-dim);
    opacity: 0.7;
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
    padding-left: calc(var(--rowpad) + var(--depth, 0) * 16px);
    cursor: pointer;
    font-size: 12.5px;
    position: relative;
  }
  .item:hover {
    background: var(--bg-hover);
    border-left-color: var(--accent);
  }
  /* row whose session is the currently-viewed tab */
  .item.current {
    border-left-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 7%, transparent);
  }
  .item.current:hover {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }
  /* keyboard-focused row (Alt+Up/Down navigation) — dashed outline
     distinguishes from the solid left-border used by .current and :hover */
  .item.nav-focused {
    outline: 1px dashed var(--accent);
    outline-offset: -1px;
  }
  .grphead.current .title {
    color: var(--accent);
  }
  /* tree guide line for nested rows, drawn in the parent's indent gutter */
  .item.child::before {
    content: '';
    position: absolute;
    left: calc(var(--rowpad) + (var(--depth) - 1) * 16px + 8px);
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--border);
    pointer-events: none;
  }
  .chev {
    flex: none;
    width: var(--chevw);
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
  /* reserved empty chevron column — rows without an expander keep the same
     left rhythm so the status-light gutter lines up across the whole list */
  .chevslot {
    flex: none;
    width: var(--chevw);
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
  /* aggregated descendant status on a collapsed parent — solid, no animation.
     Inline on LINE 1's right side, immediately before the subagent counter
     chip (plain flex:none circle — no absolute positioning) */
  .aggdot {
    width: var(--aggw);
    height: var(--aggw);
    border-radius: 50%;
    flex: none;
  }
  .aggdot.busy {
    background: var(--warn);
  }
  .aggdot.perm {
    background: var(--err);
  }
  .aggdot.ask {
    background: var(--err);
  }
  .aggdot.unread {
    background: var(--accent);
    opacity: 0.7;
  }
  .row1 {
    display: flex;
  }
  /* title fills the row so trailing line-1 elements (kidcount) pin to the
     SAME content-box right edge .stime reaches on line 2 via margin-left:auto
     — the chip sits directly above the time by construction, not coincidence */
  .row1 .title {
    flex: 1;
  }
  .title {
    display: flex;
    align-items: center;
    gap: var(--rowgap);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* the bare title text is its own flex item — without min-width:0 its
     min-content width pins the whole one-line title and pushes the trailing
     kidcount/aggdot past the clip edge; give the TEXT the overflow instead so
     it ellipsizes and dot/chev/badge/light always stay visible. flex:1 grows
     short titles too, pushing kidcount out to the row's right edge (above
     .stime) instead of letting it hug the text */
  .ttext {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dot {
    width: var(--dotw);
    height: var(--dotw);
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
  /* source order = precedence: perm > ask > busy > unread */
  .dot.ask {
    background: var(--err);
  }
  .dot.perm {
    background: var(--err);
  }
  .meta {
    color: var(--fg-dim);
    font-size: 11.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* line 2: meta starts at line 1's title column, relative time pinned to
     the far end. The meta content gets its own .smeta wrapper (anonymous
     flex items can't be styled) so long meta ellipsizes while the time stays
     fully visible */
  .sub {
    display: flex;
    align-items: baseline;
    gap: var(--rowgap);
    /* meta starts where line 1's title text starts: chevron column + dot
       column, mirrored from the same tokens the title prefix is built from
       (the aggregate light stacks INSIDE the dot column — no extra term) */
    padding-left: calc(var(--chevw) + var(--rowgap) + var(--dotw) + var(--rowgap));
    color: var(--fg-dim);
    font-size: 11.5px;
    white-space: nowrap;
  }
  /* hide-subagents mode: chevrons never render, so the reserved chevron
     column is reclaimed and line 1's prefix shrinks to just the dot column.
     .flat is set on the list container from $hideSubagents — no per-row
     conditionals; search-result rows contain neither .chevslot nor .sub */
  .list.flat .chevslot {
    display: none;
  }
  .list.flat .sub {
    padding-left: calc(var(--dotw) + var(--rowgap));
  }
  .smeta {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .stime {
    flex: none;
    margin-left: auto;
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
  /* grouped search results: session header row + slightly indented hits */
  .grphead {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    padding: 7px 12px 2px;
    font-size: 12.5px;
  }
  .grphead .title {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* hint never shrinks — title absorbs overflow and ellipsizes instead */
  .grphead .meta {
    flex: none;
  }
  .item.hit {
    padding-left: 28px;
  }
  /* match highlight inside search snippets — quiet accent tint */
  .snippet .hl {
    background: color-mix(in srgb, var(--accent) 28%, transparent);
    border-radius: 2px;
    color: inherit;
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
