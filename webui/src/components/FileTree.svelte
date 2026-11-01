<script lang="ts">
  import { fsList, dirtyBadge, fmtSize, isFsDenied, type FsItem } from '../lib/fs'
  import { isTouched } from '../lib/changes'

  // One directory of the tree. Children mount lazily — an instance exists only
  // for an EXPANDED directory, so the walk costs one /oc/fs/list per dir the
  // user actually opened. Nothing here ever recurses on the server.
  export let cwd: string
  export let path: string
  export let depth = 0
  /** Expanded dirs, owned by the drawer: reveal-on-edit writes to this set. */
  export let expanded: Set<string>
  export let dirty: Map<string, string>
  export let dirCounts: Map<string, number>
  export let touched: Set<string>
  export let onPick: (item: FsItem) => void
  export let onToggle: (path: string, open: boolean) => void

  let items: FsItem[] = []
  let truncated = false
  let error = ''
  let loading = false

  async function load() {
    loading = true
    error = ''
    try {
      const res = await fsList(cwd, path)
      items = res.items
      truncated = res.truncated
    } catch (e: any) {
      error = isFsDenied(e) ? 'outside the workspace' : String(e?.message ?? e)
    } finally {
      loading = false
    }
  }

  load()

  const base = (p: string) => p.split('/').pop() ?? p
</script>

<div class="dir" class:nested={depth > 0}>
  {#if depth > 0}
    <button class="crumb" on:click={() => onToggle(path, false)}>▾ {base(path)}</button>
  {/if}
  {#if error}
    <div class="note">⚠ {error}</div>
  {:else if loading && !items.length}
    <div class="note">loading…</div>
  {/if}
  {#each items as item (item.path)}
    {#if item.isDirectory}
      <button
        class="row dirrow"
        class:escapes={item.escapes}
        class:linked={item.symlink}
        title={item.escapes ? `${item.path} — points outside the workspace` : item.path}
        on:click={() => (item.escapes ? null : onToggle(item.path, true))}
      >
        <span class="tw">{expanded.has(item.path) ? '▾' : '▸'}</span>
        <span class="nm">{item.name}</span>
        {#if item.escapes}
          <span class="badge esc" title="points outside the workspace ceiling">⚠</span>
        {:else if dirCounts.get(item.path)}
          <span class="badge roll">{dirCounts.get(item.path)}</span>
        {/if}
      </button>
      {#if expanded.has(item.path) && !item.escapes}
        <svelte:self
          {cwd}
          path={item.path}
          depth={depth + 1}
          {expanded}
          {dirty}
          {dirCounts}
          {touched}
          {onPick}
          {onToggle}
        />
      {/if}
    {:else}
      <button
        class="row"
        class:escapes={item.escapes}
        class:linked={item.symlink}
        title={item.escapes ? `${item.path} — points outside the workspace` : item.path}
        on:click={() => onPick(item)}
      >
        <span class="tw"></span>
        <span class="nm">{item.name}</span>
        {#if item.escapes}
          <span class="badge esc" title="points outside the workspace ceiling">⚠</span>
        {:else}
          {#if dirty.get(item.path)}
            <span class="badge git" title={dirty.get(item.path)}>{dirtyBadge(dirty.get(item.path))}</span>
          {/if}
          {#if isTouched(touched, item.path)}
            <span class="badge sess" title="changed by this session">·</span>
          {/if}
          <span class="sz">{fmtSize(item.size)}</span>
        {/if}
      </button>
    {/if}
  {/each}
  {#if truncated}
    <div class="note">… more entries than the listing cap</div>
  {/if}
</div>

<style>
  .dir {
    min-width: 0;
  }
  .dir.nested {
    padding-left: 12px;
    border-left: 1px solid var(--border);
  }
  .row,
  .crumb {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    text-align: left;
    background: transparent;
    border: 0;
    border-radius: 4px;
    color: var(--fg);
    font: inherit;
    font-size: 12px;
    padding: 2px 6px;
    cursor: pointer;
    box-sizing: border-box;
  }
  .row:hover,
  .crumb:hover {
    background: var(--bg-hover, var(--bg-panel));
  }
  .dirrow .nm {
    font-weight: 600;
  }
  .crumb {
    color: var(--fg-dim);
    font-weight: 600;
  }
  .tw {
    width: 10px;
    flex-shrink: 0;
    color: var(--fg-dim);
    font-size: 10px;
  }
  .nm {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .sz {
    color: var(--fg-dim);
    font-size: 10.5px;
    flex-shrink: 0;
    font-family: var(--mono);
  }
  .badge {
    flex-shrink: 0;
    font-size: 10px;
    line-height: 1;
    padding: 2px 3px;
    border-radius: 3px;
  }
  .badge.git {
    color: var(--accent);
  }
  .badge.sess {
    color: var(--fg-dim);
  }
  .badge.roll {
    color: var(--fg-dim);
    border: 1px solid var(--border);
  }
  .badge.esc {
    color: var(--err);
  }
  .row.escapes,
  .dirrow.escapes {
    opacity: 0.45;
    cursor: default;
  }
  .note {
    color: var(--fg-dim);
    font-size: 11px;
    padding: 3px 6px;
  }
</style>
