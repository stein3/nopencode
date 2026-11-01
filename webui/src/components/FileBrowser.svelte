<script lang="ts">
  import { onDestroy } from 'svelte'
  import {
    fsAvailable,
    fsBump,
    fsFind,
    fsStatus,
    dirtyMap,
    dirtyDirs,
    isFsUnsupported,
    type FsItem,
    type FsMatch,
    type FsStatus,
  } from '../lib/fs'
  import { sessionChanges, touchedFiles } from '../lib/changes'
  import { fsTick, type Tab } from '../lib/stores'
  import FileTree from './FileTree.svelte'
  import FileViewer from './FileViewer.svelte'

  // The Files tab: the session's workspace tree, badged by GIT (not by the
  // transcript), with a read-only viewer under it. `cwd` is the session's
  // directory, so one drawer serves N workspaces and a session in a renamed
  // workspace still browses something that exists (the bridge hands out the
  // liveCwd() fallback, never the dead header path).
  export let cwd = ''
  export let tab: Tab | null = null
  export let visible = false
  export let onClose: () => void = () => {}

  let status: FsStatus | null = null
  let selected = ''
  let viewMode: 'file' | 'diff' = 'file'
  let expanded = new Set<string>()
  let query = ''
  let matches: FsMatch[] | null = null
  let findTruncated = false
  let onlyDirty = false
  let error = ''
  let unsupported = false
  let refreshMs = 0

  $: dirty = dirtyMap(status)
  $: dirCounts = dirtyDirs(status, status?.toplevel ?? cwd)
  // The transcript's own touch set, kept as a SECOND, weaker badge: git says a
  // file is dirty (maybe by another agent), the dot says THIS session touched it.
  $: changes = sessionChanges(tab ?? undefined)
  $: touched = touchedFiles(changes)

  async function loadStatus(force = false) {
    if (!cwd) return
    try {
      status = await fsStatus(cwd, force)
      error = status.error ?? ''
    } catch (e: any) {
      if (isFsUnsupported(e)) {
        unsupported = true
        return
      }
      status = null
      error = String(e?.message ?? e)
    }
  }

  // open / workspace switch / the drawer becoming visible
  $: if (visible && cwd) {
    loadStatus()
  }

  // turn ended (SSE session.idle bumps the tick): drop the caches and re-read
  // git. The ONLY refresh besides `↻` — no watcher, no timer.
  $: if ($fsTick && visible) {
    fsBump()
    loadStatus(true)
  }

  // reveal-on-edit: the newest edit the session made, while the drawer is open
  $: if (visible && changes.length) reveal(changes[changes.length - 1].file)

  // NOTE: onlyDirty and status must both appear in this statement's own
  // condition — a Svelte reactive statement tracks only the identifiers it
  // references itself, not what the function it calls reads (that bug made the
  // file|diff toggle a no-op; fsbox-check caught it).
  $: if (visible && onlyDirty && status) expandDirty()

  // Turning the filter on must show the dirt, not a list of closed folders:
  // every ancestor of every dirty path opens at once (same ancestor walk
  // reveal-on-edit uses).
  function expandDirty() {
    const next = new Set(expanded)
    let changed = false
    for (const d of status?.dirty ?? []) {
      for (const a of ancestors(d.abs)) if (!next.has(a)) { next.add(a); changed = true }
    }
    if (changed) expanded = next
  }

  function ancestors(target: string): string[] {
    if (!cwd || !target) return []
    const abs = target.startsWith('/') ? target : joinRel(cwd, target)
    if (!abs.startsWith(cwd)) return []
    const out: string[] = []
    let cur = abs
    while (cur.length > cwd.length) {
      const parent = cur.slice(0, cur.lastIndexOf('/'))
      if (!parent || parent.length < cwd.length || parent === cur) break
      out.push(parent)
      cur = parent
    }
    return out
  }

  function joinRel(root: string, rel: string): string {
    // transcript paths are either absolute under the worktree or relative to
    // the session cwd; the tree needs the absolute form either way
    const cleaned = rel.replace(/^\.\//, '')
    return cleaned.startsWith('/') ? cleaned : `${root.replace(/\/+$/, '')}/${cleaned}`
  }

  function reveal(file: string) {
    const abs = joinRel(cwd, file)
    const need = ancestors(abs)
    if (!need.length && !abs.startsWith(cwd)) return
    let changed = false
    const next = new Set(expanded)
    for (const a of need) {
      if (!next.has(a)) {
        next.add(a)
        changed = true
      }
    }
    if (changed) expanded = next
    if (abs.startsWith(cwd)) select(abs)
  }

  function select(abs: string) {
    selected = abs
    viewMode = dirty.has(abs) ? 'diff' : 'file'
  }

  function onToggle(p: string, open: boolean) {
    const next = new Set(expanded)
    if (open) next.add(p)
    else next.delete(p)
    expanded = next
  }

  function onPick(item: FsItem) {
    if (item.escapes) return
    if (item.isDirectory) return onToggle(item.path, true)
    select(item.path)
  }

  // filename search — names only, never contents (see docs/file-browser.md)
  let findTimer: ReturnType<typeof setTimeout> | undefined
  function onQuery() {
    clearTimeout(findTimer)
    findTimer = setTimeout(async () => {
      const q = query.trim()
      if (!q) {
        matches = null
        return
      }
      try {
        const r = await fsFind(cwd, q)
        matches = r.matches
        findTruncated = r.truncated
      } catch (e: any) {
        matches = []
        error = String(e?.message ?? e)
      }
    }, 120)
  }

  const base = (p: string) => p.split('/').pop() ?? p
  $: dirtyCount = status?.dirty?.length ?? 0

  onDestroy(() => clearTimeout(findTimer))
</script>

<div class="fb">
  <div class="toolbar">
    <input class="filter" placeholder="find files…" bind:value={query} on:input={onQuery} />
    <label class="only" title="show only files git reports as changed">
      <input type="checkbox" bind:checked={onlyDirty} />
      <span>dirty</span>
    </label>
    <span class="count" title={cwd}>
      {#if status?.repo}
        {status.branch ?? 'detached'}{#if dirtyCount} · {dirtyCount} dirty{/if}{#if status.scoped} (partial){/if}
      {:else}
        {#if status}{base(status.root)}{:else}{base(cwd)}{/if}
      {/if}
    </span>
    <button
      title="reload this listing and re-read git status"
      on:click={() => {
        fsBump()
        loadStatus(true)
      }}>↻</button>
    <button class="close" title="Close" on:click={onClose}>✕</button>
  </div>

  {#if unsupported}
    <div class="note">this backend has no file browser (/oc/fs/* is not wired)</div>
  {:else if !cwd}
    <div class="note">no workspace for this session</div>
  {:else}
    {#if error}<div class="note err">⚠ {error}</div>{/if}
    <div class="tree">
      {#if matches}
        {#if !matches.length}<div class="note">no file name matches “{query.trim()}”</div>{/if}
        {#each matches as m (m.path)}
          <button class="hit" title={m.path} on:click={() => (m.isDirectory ? reveal(m.path) : select(m.path))}>
            <span class="nm">{m.name}</span>
            <span class="where">{m.path.slice(cwd.length + 1)}</span>
            {#if m.isDirectory}<span class="badge">dir</span>{/if}
          </button>
        {/each}
        {#if findTruncated}<div class="note">… more matches than the cap</div>{/if}
      {:else}
        <FileTree
          {cwd}
          path={cwd}
          depth={0}
          {expanded}
          {dirty}
          {dirCounts}
          {touched}
          {onPick}
          {onToggle}
          {onlyDirty}
        />
      {/if}
    </div>
    {#if selected}
      <FileViewer {cwd} path={selected} bind:mode={viewMode} {visible} />
    {:else}
      <div class="hint">pick a file to view it — dirty files open on their git diff</div>
    {/if}
  {/if}
</div>

<style>
  .fb {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-width: 0;
    background: var(--bg);
  }
  .toolbar {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
  }
  .only {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--fg-dim);
    cursor: pointer;
    flex-shrink: 0;
    white-space: nowrap;
  }
  .only input {
    accent-color: var(--accent);
    margin: 0;
    cursor: pointer;
  }
  .filter {
    flex: 1;
    min-width: 0;
    background: var(--bg-panel);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 4px 8px;
    font-size: 12px;
    outline: none;
  }
  .filter:focus {
    border-color: var(--accent);
  }
  .count {
    color: var(--fg-dim);
    font-size: 11.5px;
    white-space: nowrap;
    max-width: 34%;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  button {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 5px;
    color: var(--fg-dim);
    cursor: pointer;
    padding: 3px 8px;
    font-size: 11.5px;
  }
  button:hover {
    color: var(--fg);
  }
  button.close {
    margin-left: auto;
    font-size: 13px;
  }
  .tree {
    overflow: auto;
    max-height: 44%;
    flex-shrink: 0;
    padding: 4px 6px;
  }
  .hit {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    text-align: left;
    background: transparent;
    border: 0;
    border-radius: 4px;
    padding: 2px 6px;
    font-size: 12px;
    color: var(--fg);
    cursor: pointer;
  }
  .hit:hover {
    background: var(--bg-hover, var(--bg-panel));
  }
  .hit .nm {
    font-weight: 600;
    flex-shrink: 0;
  }
  .hit .where {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fg-dim);
    font-size: 10.5px;
    direction: rtl;
    text-align: left;
  }
  .badge {
    font-size: 10px;
    color: var(--fg-dim);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 1px 3px;
  }
  .note {
    padding: 6px 10px;
    font-size: 11.5px;
    color: var(--fg-dim);
  }
  .note.err {
    color: var(--err);
  }
  .hint {
    margin: auto;
    padding: 10px 18px;
    color: var(--fg-dim);
    font-size: 12px;
    text-align: center;
  }
</style>
