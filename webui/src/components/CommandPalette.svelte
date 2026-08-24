<script lang="ts">
  import { tick } from 'svelte'
  import { paletteOpen, cmdVersion } from '../lib/stores'
  import { registry, type Cmd } from '../lib/commands'

  export let sessionId: string | null = null
  export let onDone: () => void = () => {}

  let query = ''
  let sel = 0
  let inputEl: HTMLInputElement
  let listEl: HTMLElement

  // (re)initialise each time the palette opens; retry focus — some browsers
  // drop programmatic focus when the element was just inserted.
  $: if ($paletteOpen) {
    query = ''
    sel = 0
    registry.load()
    focusInput()
  }

  async function focusInput() {
    await tick()
    inputEl?.focus()
    setTimeout(() => {
      if ($paletteOpen && document.activeElement !== inputEl) {
        inputEl?.focus()
        inputEl?.select()
      }
    }, 60)
  }

  $: if ($cmdVersion >= 0) cmds = registry.all()
  let cmds: Cmd[] = []

  $: filtered = match(query)

  function match(q: string): Cmd[] {
    const ql = q.trim().toLowerCase()
    const words = ql.split(/\s+/)
    return cmds.filter((c) => {
      const hay = (c.name + ' ' + c.description).toLowerCase()
      return words.every((w) => hay.includes(w))
    })
  }

  // keep keyboard selection in view
  $: if (listEl && filtered[sel]) {
    tick().then(() => listEl.querySelector('.row.active')?.scrollIntoView({ block: 'nearest' }))
  }

  function close() {
    paletteOpen.set(false)
    onDone()
  }

  async function run(c: Cmd) {
    close()
    try {
      await c.run(ctxFor(sessionId), '')
    } catch (e: any) {
      console.error('command failed', e)
    }
  }

  function ctxFor(sid: string | null) {
    return {
      sessionId: () => sid,
      newChat: () => window.dispatchEvent(new CustomEvent('oc:new-chat')),
      focusComposer: () => document.getElementById('composer-input')?.focus(),
      focusSidebar: () => document.dispatchEvent(new CustomEvent('oc:focus-sidebar')),
    }
  }

  function key(e: KeyboardEvent) {
    if (e.key === 'Escape') close()
    else if (e.key === 'ArrowDown') {
      e.preventDefault()
      sel = Math.min(sel + 1, filtered.length - 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      sel = Math.max(sel - 1, 0)
    } else if (e.key === 'Enter' && filtered[sel]) {
      e.preventDefault()
      run(filtered[sel])
    }
  }
</script>

{#if $paletteOpen}
  <div class="overlay" role="presentation" on:mousedown={close}>
    <div class="panel" role="presentation" on:mousedown|stopPropagation>
      <!-- mousedown-preventDefault keeps click-focus from blurring the input -->
      <div class="inputrow" role="presentation" on:mousedown|preventDefault={() => {}}>
        <input
          bind:this={inputEl}
          bind:value={query}
          placeholder="Type a command…"
          spellcheck="false"
          autocomplete="off"
          on:keydown={key}
        />
      </div>
      <div class="list" bind:this={listEl}>
        {#each filtered as c, i (c.source + '/' + c.name)}
          <button
            class="row"
            class:active={i === sel}
            on:click={() => run(c)}
            on:mousemove={() => (sel = i)}
          >
            <span class="name">/{c.name}</span>
            <span class="desc">{c.description}</span>
            <span class="badge {c.source}">{c.source === 'builtin' ? '' : c.source}</span>
          </button>
        {:else}
          <div class="none">no matching command</div>
        {/each}
      </div>
      <div class="foot">↑↓ navigate · ↵ run · esc close · ctrl+p toggle</div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    z-index: 100;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 12vh;
  }
  .panel {
    width: min(560px, 92vw);
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55);
  }
  .inputrow {
    border-bottom: 1px solid var(--border);
    cursor: text;
  }
  input {
    width: 100%;
    box-sizing: border-box;
    background: transparent;
    color: var(--fg);
    border: none;
    outline: none;
    padding: 13px 16px;
    font-size: 14px;
  }
  .list {
    max-height: 46vh;
    overflow-y: auto;
    padding: 4px;
  }
  .row {
    display: flex;
    gap: 10px;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: var(--fg);
    padding: 8px 10px;
    cursor: pointer;
    font-size: 13px;
    align-items: baseline;
  }
  .row.active {
    background: var(--bg-hover);
  }
  .name {
    font-family: var(--mono);
    color: var(--accent);
    white-space: nowrap;
  }
  .desc {
    flex: 1;
    color: var(--fg-dim);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .badge {
    font-size: 9.5px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border: 1px solid var(--border);
    color: var(--fg-dim);
    border-radius: 4px;
    padding: 1px 5px;
    flex-shrink: 0;
  }
  .badge.skill {
    color: #c9a7f7;
    border-color: #5a4472;
  }
  .none {
    padding: 12px;
    color: var(--fg-dim);
    font-size: 12.5px;
  }
  .foot {
    border-top: 1px solid var(--border);
    padding: 6px 12px;
    font-size: 11px;
    color: var(--fg-dim);
    user-select: none;
  }
</style>
