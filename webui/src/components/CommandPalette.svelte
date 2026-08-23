<script lang="ts">
  import { tick } from 'svelte'
  import { oc } from '../lib/api'
  import { paletteOpen } from '../lib/stores'

  export let sessionId: string | null = null
  export let onDone: () => void = () => {}

  let query = ''
  let sel = 0
  let inputEl: HTMLInputElement
  let commands: { name: string; description?: string }[] = []

  $: open = $paletteOpen
  $: if (open) {
    load()
    query = ''
    sel = 0
    tick().then(() => inputEl?.focus())
  }

  async function load() {
    if (!commands.length) commands = await oc.commands().catch(() => [])
  }

  $: filtered = commands.filter((c) =>
    (c.name + ' ' + (c.description ?? '')).toLowerCase().includes(query.toLowerCase()),
  )

  function close() {
    paletteOpen.set(false)
    onDone()
  }

  async function run(c: { name: string }) {
    close()
    if (sessionId) await oc.runCommand(sessionId, c.name).catch(() => {})
  }

  function key(e: KeyboardEvent) {
    if (e.key === 'Escape') close()
    else if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, filtered.length - 1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0) }
    else if (e.key === 'Enter' && filtered[sel]) run(filtered[sel])
  }
</script>

{#if open}
  <div class="overlay" on:mousedown={close}>
    <div class="panel" on:mousedown|stopPropagation>
      <input
        bind:this={inputEl}
        bind:value={query}
        placeholder="Type a command…"
        on:keydown={key}
      />
      <div class="list">
        {#each filtered as c, i (c.name)}
          <button class="row" class:active={i === sel} on:click={() => run(c)} on:mousemove={() => (sel = i)}>
            <span class="name">/{c.name}</span>
            <span class="desc">{c.description ?? ''}</span>
          </button>
        {:else}
          <div class="none">no matching command</div>
        {/each}
      </div>
      <div class="foot">↑↓ navigate · ↵ run · esc close</div>
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
  input {
    width: 100%;
    box-sizing: border-box;
    background: transparent;
    color: var(--fg);
    border: none;
    outline: none;
    padding: 13px 16px;
    font-size: 14px;
    border-bottom: 1px solid var(--border);
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
    color: var(--fg-dim);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
