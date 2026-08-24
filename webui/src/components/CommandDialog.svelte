<script lang="ts">
  import { tick } from 'svelte'
  import { dialog, type DialogRow } from '../lib/stores'

  let panelEl: HTMLElement

  function close() {
    dialog.set(null)
  }

  $: if ($dialog) focusFirst()

  async function focusFirst() {
    await tick()
    const first = panelEl?.querySelector('button.row') as HTMLElement | null
    ;(first ?? panelEl)?.focus?.()
  }

  function key(e: KeyboardEvent) {
    if (e.key === 'Escape') close()
    if (!$dialog?.rows) return
    const rows = [...panelEl.querySelectorAll('button.row')] as HTMLElement[]
    const cur = rows.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown' && cur >= 0) {
      e.preventDefault()
      rows[(cur + 1) % rows.length]?.focus()
    } else if (e.key === 'ArrowUp' && cur >= 0) {
      e.preventDefault()
      rows[(cur - 1 + rows.length) % rows.length]?.focus()
    }
  }

  function pick(row: DialogRow) {
    close()
    row.onPick?.()
  }
</script>

{#if $dialog}
  <div class="overlay" on:mousedown={close}>
    <div
      class="panel"
      role="dialog"
      aria-label={$dialog.title}
      tabindex="-1"
      bind:this={panelEl}
      on:mousedown|stopPropagation
      on:keydown={key}
    >
      <div class="title">{$dialog.title}</div>
      {#if $dialog.rows?.length}
        <div class="list">
          {#each $dialog.rows as r (r.label)}
            <button class="row" on:click={() => pick(r)}>
              <span class="label">{r.label}</span>
              {#if r.hint}<span class="hint">{r.hint}</span>{/if}
              {#if r.desc}<span class="desc">{r.desc}</span>{/if}
            </button>
          {/each}
        </div>
      {:else if $dialog.pre !== undefined}
        <pre class="pre">{$dialog.pre}</pre>
      {:else}
        <div class="list"><div class="desc empty">(empty)</div></div>
      {/if}
      {#if $dialog.note}
        <div class="note">{$dialog.note}</div>
      {/if}
      <div class="foot">esc close</div>
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
    width: min(600px, 92vw);
    max-height: 68vh;
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
  .list {
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
  .row:hover,
  .row:focus-visible {
    background: var(--bg-hover);
    outline: none;
  }
  .label {
    font-family: var(--mono);
    color: var(--accent);
    white-space: nowrap;
  }
  .hint {
    font-size: 10px;
    color: var(--accent);
    border: 1px solid var(--accent);
    border-radius: 4px;
    padding: 0 5px;
    flex-shrink: 0;
  }
  .desc {
    flex: 1;
    color: var(--fg-dim);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pre {
    margin: 0;
    padding: 14px 16px;
    overflow: auto;
    font-size: 11.5px;
    line-height: 1.5;
    font-family: var(--mono);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .empty {
    padding: 12px;
  }
  .note {
    padding: 6px 16px 2px;
    font-size: 11px;
    color: var(--fg-dim);
  }
  .foot {
    margin-top: auto;
    border-top: 1px solid var(--border);
    padding: 6px 12px;
    font-size: 11px;
    color: var(--fg-dim);
    user-select: none;
  }
</style>
