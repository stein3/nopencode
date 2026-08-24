<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte'
  import * as monaco from 'monaco-editor/editor/editor.api'
  import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
  import {
    cachedDiffs,
    fetchDiffs,
    parsedFor,
    fullPairFor,
    type DiffFile,
    type ParsedDiff,
  } from '../lib/diffs'

  export let sessionId: string
  export let visible = false

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

  let editor: monaco.editor.IStandaloneDiffEditor | null = null

  function ensureEditor() {
    if (editor || !container) return
    editor = monaco.editor.createDiffEditor(container, {
      theme: 'oc-dark',
      readOnly: true,
      automaticLayout: true,
      renderSideBySide: true,
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
    const k = `${sessionId || 'worktree'}:${f.file}:${fullMode ? 'full' : 'hunks'}`
    const parsedOrUndefined = !fullMode ? parsedFor(sessionId, f) : undefined
    if (!fullMode && parsedOrUndefined) {
      pairModels(k, parsedOrUndefined)
      return
    }
    if (fullMode) {
      fullLoading = true
      try {
        pairModels(k, await fullPairFor(sessionId, f))
      } catch {
        // binary/new file etc — fall back to hunk view content
        pairModels(k.replace(':full', ':hunks'), parsedFor(sessionId, f))
      } finally {
        fullLoading = false
      }
    } else {
      pairModels(k, parsedFor(sessionId, f))
    }
  }

  async function load(force = false) {
    loading = true
    error = ''
    try {
      const res = await fetchDiffs(sessionId, force)
      files = res.files
      source = res.source
      applyFilter()
      if (files.length) {
        const lastKey = lastSelection.get(sessionId || 'worktree')
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

  // lazy load on first visibility; instant reopen via module cache
  $: if (visible) {
    const c = cachedDiffs(sessionId)
    if (c && !files.length) {
      files = c.files
      source = c.source
      applyFilter()
    } else if (!c && !files.length && !loading) {
      load()
    }
  }

  function pick(f: DiffFile) {
    lastSelection.set(sessionId || 'worktree', f.file)
    show(f)
  }

  onMount(() => ensureEditor())
  onDestroy(() => {
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
    <button title="reload diffs" on:click={() => { files = []; load(true) }}>↻</button>
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
