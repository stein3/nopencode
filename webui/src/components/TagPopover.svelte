<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { sessionMeta, addTag, removeTag } from '../lib/stores'

  export let sid: string
  export let anchor: HTMLElement
  export let onClose: () => void

  let newTagInput = ''
  let inputEl: HTMLInputElement

  // all unique tags across all sessions (reactive)
  $: allTagsList = (() => {
    const set = new Set<string>()
    for (const v of Object.values($sessionMeta)) {
      if (v.tags) for (const t of v.tags) set.add(t)
    }
    return [...set].sort()
  })()

  // current session's tags
  $: sessionTags = $sessionMeta[sid]?.tags ?? []

  function toggleTag(tag: string) {
    if (sessionTags.includes(tag)) {
      removeTag(sid, tag)
    } else {
      addTag(sid, tag)
    }
  }

  function createAndApply() {
    const tag = newTagInput.trim()
    if (!tag) return
    if (!sessionTags.includes(tag)) addTag(sid, tag)
    newTagInput = ''
  }

  function onInputKey(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault()
      createAndApply()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  // position the popover near the anchor
  let style = ''
  onMount(() => {
    tick().then(() => {
      if (!anchor) return
      const rect = anchor.getBoundingClientRect()
      // prefer above the anchor, fall below if near top
      const top = rect.top > 280 ? rect.bottom + 4 : rect.top - 4
      const left = Math.min(rect.left, window.innerWidth - 220)
      style = `position:fixed;top:${top}px;left:${left}px;z-index:100`
    })
    // focus the input
    setTimeout(() => inputEl?.focus(), 30)
  })

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose()
  }

  function onDocClick(e: MouseEvent) {
    // close if click is outside this popover
    const target = e.target as HTMLElement
    if (!target.closest('.tagpopover')) onClose()
  }
</script>

<svelte:window on:keydown={onKeydown} on:click={onDocClick} />

<div class="tagpopover" {style}>
  <div class="pheader">Tags</div>
  {#if allTagsList.length}
    <div class="taglist">
      {#each allTagsList as tag}
        <button
          class="tagopt"
          class:applied={sessionTags.includes(tag)}
          on:click={() => toggleTag(tag)}
        >
          <span class="tagcheck">{sessionTags.includes(tag) ? '✓' : ''}</span>
          {tag}
        </button>
      {/each}
    </div>
  {:else}
    <div class="ptempty">No tags yet</div>
  {/if}
  <div class="pnewtag">
    <input
      bind:this={inputEl}
      bind:value={newTagInput}
      on:keydown={onInputKey}
      placeholder="New tag…"
    />
    <button class="pnewbtn" disabled={!newTagInput.trim()} on:click={createAndApply}>+</button>
  </div>
</div>

<style>
  .tagpopover {
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.25);
    min-width: 180px;
    max-width: 240px;
    font-size: 12px;
    padding: 6px;
    /* positioning is set inline from the anchor */
  }
  .pheader {
    padding: 4px 8px 2px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--fg-dim);
  }
  .ptempty {
    padding: 6px 8px;
    color: var(--fg-dim);
    font-size: 11.5px;
  }
  .taglist {
    display: flex;
    flex-direction: column;
    max-height: 180px;
    overflow-y: auto;
    margin: 2px 0;
  }
  .tagopt {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--fg);
    font-size: 12px;
    cursor: pointer;
    text-align: left;
  }
  .tagopt:hover {
    background: var(--bg-hover);
  }
  .tagopt.applied {
    color: var(--accent);
  }
  .tagcheck {
    width: 14px;
    text-align: center;
    font-size: 11px;
    color: var(--accent);
    flex-shrink: 0;
  }
  .pnewtag {
    display: flex;
    gap: 4px;
    padding-top: 4px;
    border-top: 1px solid var(--border);
    margin-top: 2px;
  }
  .pnewtag input {
    flex: 1;
    min-width: 0;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 4px 6px;
    font-size: 11.5px;
    outline: none;
  }
  .pnewtag input:focus {
    border-color: var(--accent);
  }
  .pnewbtn {
    flex: none;
    width: 26px;
    background: var(--accent);
    color: var(--bg-panel);
    border: none;
    border-radius: 4px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
  }
  .pnewbtn:hover:not(:disabled) {
    filter: brightness(1.15);
  }
  .pnewbtn:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
