<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte'
  import * as monaco from 'monaco-editor/editor/editor.api'
  import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
  // editor.api does NOT include the codicon stylesheet, so every glyph icon
  // Monaco draws (fold chevrons beside unchanged regions, diff arrows,
  // widget buttons) renders as nothing without this font-face declaration.
  // Alias defined in vite.config.ts (monaco's exports map blocks deep css).
  import 'monaco-codicons.css'
  import {
    cachedDiffs,
    fetchDiffs,
    parsedFor,
    inlineParsedFor,
    fullPairFor,
    type DiffFile,
    type ParsedDiff,
  } from '../lib/diffs'
  import { theme } from '../lib/stores'

  export let sessionId: string
  export let visible = false
  export let onClose: () => void = () => {}

  let container: HTMLElement
  let files: DiffFile[] = []
  let filtered: DiffFile[] = []
  let current: DiffFile | null = null
  let source = ''
  let error = ''
  let loading = false
  let filter = ''
  let fullMode = false
  let fullLoading = false
  // false = this session's transcript ops; true = live git worktree diff.
  // Sessions with a pending first message pass sessionId='' -> always worktree.
  let wtMode = false
  let loadedKey = ''
  // mirrors monaco's inline flip (width <= renderSideBySideInlineBreakpoint);
  // hunks models must switch to the unpadded pair in that layout
  let inlineView = false
  const INLINE_BREAKPOINT = 900

  $: srcKey = !sessionId || wtMode ? 'worktree' : sessionId

  // survives pane close/open (module scope via <script context="module"> would
  // also work; plain module-level state here is per-instance but models live in
  // diffs.ts caches so nothing is refetched)
  const modelCache = new Map<string, monaco.editor.IDiffEditorModel>()

  if (!(self as any).MonacoEnvironment) {
    ;(self as any).MonacoEnvironment = { getWorker: () => new EditorWorker() }
  }

  monaco.editor.defineTheme('oc-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#1e1e1e',
      'diffEditor.insertedTextBackground': '#2ea04326',
      'diffEditor.removedTextBackground': '#f8514926',
    },
  })

  monaco.editor.defineTheme('oc-light', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#f6f8fa',
      'editor.foreground': '#1f2328',
      'editor.lineHighlightBackground': '#eaeef280',
      'editorLineNumber.foreground': '#656d76',
      'editor.selectionBackground': '#0969da33',
      'diffEditor.insertedTextBackground': '#1e725c26',
      'diffEditor.removedTextBackground': '#cf222e26',
    },
  })

  $: {
    const isLight = $theme === 'solarized-light' || $theme === 'github-light' || $theme === 'catppuccin-latte'
    if (editor) monaco.editor.setTheme(isLight ? 'oc-light' : 'oc-dark')
  }

  let editor: monaco.editor.IStandaloneDiffEditor | null = null

  function ensureEditor() {
    if (editor || !container) return
  editor = monaco.editor.createDiffEditor(container, {
    theme: 'oc-dark',
    readOnly: true,
    automaticLayout: true,
    renderSideBySide: true,
    // flip to single-column when the pane is too narrow (monaco default
    // breakpoint: renderSideBySideInlineBreakpoint = 900px)
    useInlineViewWhenSpaceIsLimited: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontSize: 12.5,
  })
    if (current) show(current)
  }

  $: if (visible && editor) requestAnimationFrame(() => editor!.layout())

  function langOf(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase() ?? ''
    const map: Record<string, string> = {
      ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
      py: 'python', md: 'markdown', json: 'json', yaml: 'yaml', yml: 'yaml',
      sh: 'shell', html: 'html', css: 'css', svelte: 'html', rs: 'rust', go: 'go',
      toml: 'ini', sql: 'sql',
    }
    return map[ext] ?? 'plaintext'
  }

  function setModels(m: monaco.editor.IDiffEditorModel) {
    editor?.setModel(m)
  }

  function pairModels(k: string, pair: { original: string; modified: string }) {
    let m = modelCache.get(k)
    if (!m) {
      m = {
        original: monaco.editor.createModel(pair.original, langOf(current?.file ?? '')),
        modified: monaco.editor.createModel(pair.modified, langOf(current?.file ?? '')),
      }
      modelCache.set(k, m)
    }
    setModels(m)
  }

  async function show(f: DiffFile) {
    current = f
    const k = `${srcKey}:${f.file}:${fullMode ? 'full' : 'hunks'}${inlineView ? 'i' : ''}`
    const parsedOrUndefined = fullMode
      ? undefined
      : inlineView
        ? inlineParsedFor(srcKey, f)
        : parsedFor(srcKey, f)
    if (!fullMode && parsedOrUndefined) {
      pairModels(k, parsedOrUndefined)
      return
    }
    if (fullMode) {
      fullLoading = true
      try {
        pairModels(k, await fullPairFor(srcKey, f))
      } catch {
        // binary/new file etc — fall back to hunk view content
        const fb = inlineView ? inlineParsedFor(srcKey, f) : parsedFor(srcKey, f)
        pairModels(k.replace(':full', ':hunks'), fb)
      } finally {
        fullLoading = false
      }
    } else {
      pairModels(k, parsedOrUndefined!)
    }
  }

  async function load(force = false) {
    loading = true
    error = ''
    try {
      const res = await fetchDiffs(sessionId, force, wtMode)
      files = res.files
      source = res.source
      loadedKey = srcKey
      applyFilter()
      if (files.length) {
        const lastKey = lastSelection.get(srcKey)
        const target = (lastKey && files.find((f) => f.file === lastKey)) || files[0]
        await tick()
        show(target)
      }
    } catch (e: any) {
      error = e.message ?? String(e)
    } finally {
      loading = false
    }
  }

  const lastSelection = new Map<string, string>()

  function applyFilter() {
    const q = filter.trim().toLowerCase()
    filtered = q ? files.filter((f) => f.file.toLowerCase().includes(q)) : files.slice(0, 500)
  }

  $: filter, applyFilter()

  // lazy load on first visibility (or source/tab switch); instant swap via cache
  $: if (visible && loadedKey !== srcKey && !loading) {
    const c = cachedDiffs(srcKey)
    if (c) {
      files = c.files
      source = c.source
      loadedKey = srcKey
      applyFilter()
      if (files.length) {
        const lastKey = lastSelection.get(srcKey)
        show((lastKey && files.find((f) => f.file === lastKey)) || files[0])
      }
    } else {
      load()
    }
  }

  function pick(f: DiffFile) {
    lastSelection.set(srcKey, f.file)
    show(f)
  }

  let resizeObserver: ResizeObserver | undefined

  onMount(() => {
    ensureEditor()
    // Track pane width so hunk models switch between the row-aligned pair
    // (side-by-side) and the unpadded pair (inline) exactly when monaco does.
    resizeObserver = new ResizeObserver((entries) => {
      const v = entries[0].contentRect.width <= INLINE_BREAKPOINT
      if (v !== inlineView) {
        inlineView = v
        if (current && !fullMode && visible) show(current)
      }
    })
    if (container) resizeObserver.observe(container)
  })
  onDestroy(() => {
    resizeObserver?.disconnect()
    editor?.dispose()
    modelCache.forEach((m) => {
      m.original.dispose()
      m.modified.dispose()
    })
  })
</script>

<div class="diffpane">
  <div class="toolbar">
    <input class="filter" placeholder="filter files…" bind:value={filter} />
    <span class="count">{filtered.length}{files.length > 500 ? '+' : ''}/{files.length}</span>
    <button
      class:active={fullMode}
      title="toggle: patch hunks only vs whole file"
      on:click={() => {
        fullMode = !fullMode
        if (current) show(current)
      }}
    >
      {fullLoading ? '…' : fullMode ? 'whole' : 'hunks'}
    </button>
    {#if sessionId}
      <button
        class:active={!wtMode}
        title={wtMode ? 'show live worktree diff (all uncommitted changes)' : "show only this session's edits"}
        on:click={() => (wtMode = !wtMode)}
      >
        {wtMode ? 'wt' : 'sess'}
      </button>
    {/if}
    <button title="reload diffs" on:click={() => { files = []; load(true) }}>↻</button>
    <button class="close" title="Close diff pane" on:click={onClose}>✕</button>
  </div>
  <div class="meta">
    {#if source}<span class="src">{source}</span>{/if}
    {#if current}
      <span class="path" title={current.file}>{current.file}</span>
    {/if}
  </div>
  {#if error}
    <div class="err">⚠ {error} <button on:click={() => load(true)}>retry</button></div>
  {:else if loading}
    <div class="hint overlay">loading diffs…</div>
  {:else if !files.length}
    <div class="hint overlay">no changes</div>
  {/if}
  <!-- editor + list always mounted: Monaco must exist before models are set -->
  <select
    class="files"
    size={Math.min(10, Math.max(3, Math.min(filtered.length, 500)))}
    disabled={!filtered.length}
    on:change={(e) => pick(filtered[e.currentTarget.selectedIndex])}
  >
    {#each filtered as f (f.file)}
      <option value={f.file} selected={current?.file === f.file}>{f.file}</option>
    {/each}
  </select>
  <div class="editor" bind:this={container}></div>
</div>

<style>
  .diffpane {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-width: 0;
    border-left: 1px solid var(--border);
    background: var(--bg);
    position: relative;
  }
  .toolbar {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
  }
  .filter {
    flex: 1;
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
  button.active {
    color: var(--accent);
    border-color: var(--accent);
  }
  button.close {
    margin-left: auto;
    font-size: 13px;
    padding: 3px 8px;
  }
  .meta {
    display: flex;
    gap: 10px;
    padding: 4px 10px;
    font-size: 11.5px;
    color: var(--fg-dim);
    overflow: hidden;
    white-space: nowrap;
  }
  .src {
    color: var(--accent);
    flex-shrink: 0;
  }
  .path {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .err {
    padding: 10px;
    color: var(--err);
    font-size: 12px;
  }
  .hint.overlay {
    position: absolute;
    top: 40%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 5;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 18px;
    color: var(--fg-dim);
  }
  .files {
    margin: 6px 10px;
    background: var(--bg-panel);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 5px;
    font-size: 11.5px;
    font-family: var(--mono);
    outline: none;
    flex-shrink: 0;
  }
  .editor {
    flex: 1;
    min-height: 0;
  }
</style>
