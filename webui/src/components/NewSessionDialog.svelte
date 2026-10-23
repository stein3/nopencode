<script lang="ts">
  import { tick } from 'svelte'
  import { oc } from '../lib/api'

  // The TUI's new-session modal, in webui form: pick the workspace directory
  // (project chips + path type-ahead) before the tab exists. Only
  // mounted when the backend answered /oc/workspaces — opencode engines 404
  // it and App keeps the old one-click new-chat behavior.
  //
  // `open` is owned by the parent: the child never assigns it (Svelte 4 prop
  // writes don't propagate), every exit path reports through onDone instead —
  // with the cwd on a start, without one on cancel.
  export let open = false
  export let onDone: (cwd?: string) => void

  const LAST_KEY = 'piws.last'

  let inputEl: HTMLInputElement
  let value = ''
  let chips: { name: string; path: string }[] = []
  let items: { name: string; path: string }[] = [] // completion rows
  let active = -1 // highlighted completion row (-1 = none)
  let seedSeq = 0

  let debounce: ReturnType<typeof setTimeout> | undefined
  let acSeq = 0

  $: if (open) seed()
  $: if (!open) closeAc()

  async function seed() {
    const seq = ++seedSeq
    let last = ''
    try {
      last = localStorage.getItem(LAST_KEY) || ''
    } catch {
      /* private mode */
    }
    value = last
    items = []
    active = -1
    focusInput()
    oc
      .workspaces()
      .then((d) => {
        if (seq !== seedSeq) return
        chips = d.chips ?? []
        if (!value) value = chips[0]?.path || d.root || ''
        suggest()
      })
      .catch(() => {
        /* chips unavailable — the path field still works */
      })
  }

  async function focusInput() {
    await tick()
    inputEl?.focus()
    inputEl?.select()
    setTimeout(() => {
      if (open && document.activeElement !== inputEl) inputEl?.focus()
    }, 60)
  }

  // ---- directory type-ahead ------------------------------------------------
  function suggest() {
    clearTimeout(debounce)
    debounce = setTimeout(runSuggest, 120)
  }

  async function runSuggest() {
    const seq = ++acSeq
    const text = value
    try {
      const found = await oc.dirs(text)
      if (seq !== acSeq) return // superseded
      items = found.slice(0, 30)
      active = -1
    } catch {
      if (seq === acSeq) items = []
    }
  }

  function closeAc() {
    clearTimeout(debounce)
    acSeq++
    items = []
    active = -1
  }

  function accept(i: number) {
    const it = items[i]
    if (!it) return
    value = it.path + '/' // accepting a dir keeps drilling, does not close
    active = -1 // highlight is consumed — the next ↵ starts the session
    focusInput()
    suggest()
  }

  function pickChip(c: { path: string }) {
    value = c.path
    focusInput()
    suggest()
  }

  // ---- open / close / submit ----------------------------------------------
  function close() {
    closeAc()
    onDone()
  }

  function submit() {
    const cwd = value.trim()
    if (!cwd) return
    try {
      localStorage.setItem(LAST_KEY, cwd)
    } catch {
      /* private mode */
    }
    closeAc()
    onDone(cwd)
  }

  function key(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation()
      if (items.length) closeAc()
      else close()
      return
    }
    if (e.key === 'ArrowDown' && items.length) {
      e.preventDefault()
      active = (active + 1) % items.length
      return
    }
    if (e.key === 'ArrowUp' && items.length) {
      e.preventDefault()
      active = active <= 0 ? items.length - 1 : active - 1
      return
    }
    if (e.key === 'Tab' && items.length) {
      e.preventDefault()
      accept(active >= 0 ? active : 0)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      // a highlighted row means "keep browsing", otherwise start the session
      if (active >= 0) accept(active)
      else submit()
    }
  }

  // keep mouse/keyboard handling off the non-interactive role="dialog" node
  function panelHandlers(node: HTMLElement) {
    const stopMousedown = (e: Event) => e.stopPropagation()
    node.addEventListener('mousedown', stopMousedown)
    node.addEventListener('keydown', key)
    return {
      destroy() {
        node.removeEventListener('mousedown', stopMousedown)
        node.removeEventListener('keydown', key)
      },
    }
  }
</script>

{#if open}
  <div class="overlay" role="presentation" on:mousedown={close}>
    <div class="panel" role="dialog" aria-label="New session" use:panelHandlers>
      <div class="title">New session</div>
      <div class="body">
        <label for="ws-cwd">Workspace directory</label>
        <div class="fieldwrap">
          <!-- svelte-ignore a11y-autofocus -->
          <input
            id="ws-cwd"
            bind:this={inputEl}
            bind:value
            on:input={suggest}
            placeholder="/path/to/project"
            spellcheck="false"
            autocomplete="off"
          />
          {#if items.length}
            <div class="ac" role="listbox">
              {#each items as it, i (it.path)}
                <button
                  type="button"
                  class="acrow"
                  class:active={i === active}
                  role="option"
                  aria-selected={i === active}
                  on:mousedown|preventDefault={() => accept(i)}
                  on:mouseenter={() => (active = i)}
                >
                  <span class="acname">{it.name}</span>
                  <span class="acpath">{it.path}</span>
                </button>
              {/each}
            </div>
          {/if}
        </div>
        {#if chips.length}
          <div class="chips">
            {#each chips as c (c.path)}
              <button type="button" class="chip" title={c.path} on:click={() => pickChip(c)}>{c.name}</button>
            {/each}
          </div>
        {/if}
      </div>
      <div class="foot">
        <span class="keys">↵ start · esc cancel</span>
        <button class="go" on:click={submit} disabled={!value.trim()}>start</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    z-index: 110;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 14vh;
  }
  .panel {
    width: min(540px, 94vw);
    display: flex;
    flex-direction: column;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55);
    outline: none;
  }
  .title {
    padding: 10px 16px;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--fg-dim);
    border-bottom: 1px solid var(--border);
  }
  .body {
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  label {
    font-size: 11.5px;
    color: var(--fg-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .fieldwrap {
    position: relative;
  }
  input {
    width: 100%;
    box-sizing: border-box;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 6px;
    outline: none;
    padding: 9px 10px;
    font-size: 13.5px;
    font-family: var(--mono);
  }
  input:focus {
    border-color: var(--accent);
  }
  .ac {
    position: absolute;
    left: 0;
    right: 0;
    top: calc(100% + 4px);
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 6px;
    max-height: 240px;
    overflow-y: auto;
    z-index: 5;
    box-shadow: 0 12px 30px rgba(0, 0, 0, 0.45);
  }
  .acrow {
    display: flex;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    background: transparent;
    border: none;
    color: var(--fg);
    text-align: left;
    padding: 6px 10px;
    font-size: 12.5px;
    cursor: pointer;
  }
  .acrow.active {
    background: var(--bg-hover);
  }
  .acname {
    font-weight: 600;
    white-space: nowrap;
  }
  .acpath {
    color: var(--fg-dim);
    font-size: 11px;
    font-family: var(--mono);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip {
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--fg-dim);
    border-radius: 999px;
    padding: 3px 10px;
    font-size: 12px;
    cursor: pointer;
    max-width: 190px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chip:hover {
    border-color: var(--accent);
    color: var(--fg);
  }
  .foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    border-top: 1px solid var(--border);
    padding: 8px 12px;
  }
  .keys {
    font-size: 11px;
    color: var(--fg-dim);
    user-select: none;
  }
  .go {
    background: var(--accent);
    color: var(--bg-panel);
    border: none;
    border-radius: 6px;
    padding: 6px 14px;
    font-size: 12.5px;
    cursor: pointer;
  }
  .go:hover:not(:disabled) {
    filter: brightness(1.1);
  }
  .go:disabled {
    opacity: 0.45;
    cursor: default;
  }
</style>
