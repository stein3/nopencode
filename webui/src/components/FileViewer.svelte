<script lang="ts">
  import { onDestroy, tick } from 'svelte'
  import { monaco, ensureMonaco, monacoThemeFor, langOf } from '../lib/monaco'
  import { parsePatch, parsePatchInline } from '../lib/diffs'
  import { fsFile, fsDiff, fmtSize, isFsUnsupported } from '../lib/fs'
  import { theme } from '../lib/stores'

  // The Files tab's viewer: ONE file, either as it is on disk or as its git
  // diff. Deliberately NOT DiffPane — that pane answers "what did this session
  // do" (transcript ops / the merged worktree), this one answers "what did git
  // see for this path", scoped to the repo at the drawer's root. Sharing the
  // component would couple two different notions of "the diff"; they share
  // Monaco instead (lib/monaco.ts).
  export let cwd: string
  export let path = ''
  export let visible = true
  /** 'file' | 'diff'. The parent sets 'diff' when the tree says the path is dirty. */
  export let mode: 'file' | 'diff' = 'file'
  export let inline = false // narrow drawer → unpadded hunk models, as DiffPane does

  let container: HTMLElement
  let note = ''
  let error = ''
  let loading = false
  let size: number | null = null
  let imageUrl = ''
  let kind: 'none' | 'text' | 'diff' | 'image' = 'none'
  let truncated = false

  let editor: monaco.editor.IStandaloneCodeEditor | null = null
  let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null
  let model: monaco.editor.ITextModel | null = null
  let pair: monaco.editor.IDiffEditorModel | null = null

  // `mode` MUST be in the condition: a reactive statement tracks only the
  // identifiers it references itself, so `load()` reading `mode` internally is
  // invisible to Svelte and the file|diff toggle would never reload (found by
  // fsbox-check: the toggle left the diff editor on screen).
  $: if (visible && path && cwd && mode) load()
  $: if (editor) monaco.editor.setTheme(monacoThemeFor($theme))
  $: if (diffEditor) monaco.editor.setTheme(monacoThemeFor($theme))

  function destroyEditors() {
    editor?.dispose()
    diffEditor?.dispose()
    editor = null
    diffEditor = null
    model?.dispose()
    model = null
    if (pair) {
      pair.original.dispose()
      pair.modified.dispose()
      pair = null
    }
    if (container) container.innerHTML = ''
    kind = 'none'
  }

  function showText(text: string) {
    ensureMonaco()
    if (!editor) editor = monaco.editor.create(container, {
      theme: monacoThemeFor($theme),
      readOnly: true,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 12.5,
      renderWhitespace: 'none',
    })
    model?.dispose()
    model = monaco.editor.createModel(text, langOf(path))
    editor.setModel(model)
    kind = 'text'
  }

  function showDiff(patch: string) {
    ensureMonaco()
    if (!diffEditor) {
      diffEditor = monaco.editor.createDiffEditor(container, {
        theme: monacoThemeFor($theme),
        readOnly: true,
        automaticLayout: true,
        renderSideBySide: !inline,
        useInlineViewWhenSpaceIsLimited: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 12.5,
      })
    }
    if (pair) {
      pair.original.dispose()
      pair.modified.dispose()
    }
    const parsed = inline ? parsePatchInline(patch) : parsePatch(patch)
    pair = {
      original: monaco.editor.createModel(parsed.original, langOf(path)),
      modified: monaco.editor.createModel(parsed.modified, langOf(path)),
    }
    diffEditor.setModel(pair)
    kind = 'diff'
  }

  async function load() {
    loading = true
    error = ''
    imageUrl = ''
    note = ''
    try {
      if (mode === 'diff') {
        const d = await fsDiff(cwd, path)
        await tick()
        if (!container) return
        destroyEditors()
        if (!d.patch.trim()) {
          note = 'git reports no change for this path'
          size = null
          return
        }
        truncated = d.truncated
        showDiff(d.patch)
        return
      }
      const f = await fsFile(cwd, path)
      size = f.size
      truncated = !!f.truncated
      await tick()
      if (!container) return
      destroyEditors()
      if (f.type === 'text') {
        showText(f.content ?? '')
      } else if (f.type === 'image') {
        imageUrl = `data:${f.mime ?? 'image/png'};base64,${f.base64 ?? ''}`
        kind = 'image'
      } else if (f.type === 'too_large') {
        note = `${fmtSize(f.size)} — over the ${fmtSize(1024 * 1024)} preview cap`
      } else {
        note = `binary (${fmtSize(f.size)}) — no preview`
      }
    } catch (e: any) {
      destroyEditors()
      error = isFsUnsupported(e) ? 'no file browser on this backend' : String(e?.message ?? e)
    } finally {
      loading = false
    }
  }

  const base = (p: string) => p.split('/').pop() ?? p

  onDestroy(destroyEditors)
</script>

<div class="viewer">
  <div class="head">
    <span class="p" title={path}>{base(path)}</span>
    <span class="spacer"></span>
    {#if size != null}<span class="sz">{fmtSize(size)}</span>{/if}
    <button class:active={mode === 'file'} title="the file as it is on disk" on:click={() => (mode = 'file')}>file</button>
    <button class:active={mode === 'diff'} title="git diff for this path (vs HEAD)" on:click={() => (mode = 'diff')}>diff</button>
  </div>
  {#if error}
    <div class="err">⚠ {error}</div>
  {:else if loading}
    <div class="note">loading…</div>
  {:else if note}
    <div class="note">{note}</div>
  {/if}
  {#if imageUrl}
    <div class="imgwrap"><img src={imageUrl} alt={base(path)} /></div>
  {/if}
  <!-- the container stays mounted: Monaco must exist before a model is set -->
  <div class="editor" bind:this={container} class:hidden={!!imageUrl || !!error || !!note}></div>
  {#if truncated}<div class="note">… truncated</div>{/if}
</div>

<style>
  .viewer {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
    border-top: 1px solid var(--border);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    border-bottom: 1px solid var(--border);
    font-size: 11.5px;
    color: var(--fg-dim);
    min-width: 0;
  }
  .p {
    font-family: var(--mono);
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .spacer {
    flex: 1;
  }
  .sz {
    font-size: 10.5px;
    white-space: nowrap;
  }
  button {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--fg-dim);
    cursor: pointer;
    padding: 2px 6px;
    font-size: 11px;
  }
  button:hover {
    color: var(--fg);
  }
  button.active {
    color: var(--accent);
    border-color: var(--accent);
  }
  .editor {
    flex: 1;
    min-height: 0;
  }
  .editor.hidden {
    display: none;
  }
  .imgwrap {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 8px;
    text-align: center;
  }
  .imgwrap img {
    max-width: 100%;
    max-height: 60vh;
  }
  .note,
  .err {
    padding: 6px 8px;
    font-size: 11.5px;
    color: var(--fg-dim);
  }
  .err {
    color: var(--err);
  }
</style>
