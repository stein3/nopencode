<script lang="ts">
  import { tabs, pendingQuestions } from '../lib/stores'

  export let onClose: (id: string) => void
  export let onNewChat: () => void

  // sessions with a pending engine question-tool request — red dot, wins over
  // busy/dirty (same signal as the sidebar .ask dot)
  $: askSet = new Set($pendingQuestions.map((q) => q.sessionID).filter((x): x is string => !!x))

  const active = tabs.active

  const titles: Record<string, string> = {
    'Ctrl+T': 'new chat',
    'Ctrl+W': 'close tab',
  }

  // keep the newest opened tab and the active tab visible in the horizontal
  // scroller (issue #3): opening appends offscreen-right; Alt+←→ / Ctrl+N
  // cycling can park the active tab outside the visible strip. scrollIntoView
  // with block:'nearest' never jumps the page vertically and no-ops when the
  // target is already fully visible.
  let bar: HTMLDivElement | null = null
  let prevLast = ''
  let prevActive = ''
  $: syncScroll($tabs, $active)
  function syncScroll(list: { id: string }[], activeId: string) {
    const last = list.length ? list[list.length - 1].id : ''
    if (last === prevLast && activeId === prevActive) return
    prevLast = last
    prevActive = activeId
    requestAnimationFrame(() => revealTab(activeId))
  }
  function revealTab(activeId: string) {
    if (!bar) return
    const el =
      (activeId ? (bar.querySelector(`[data-sid="${CSS.escape(activeId)}"]`) as HTMLElement | null) : null) ??
      (bar.lastElementChild as HTMLElement | null)
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
</script>

<div class="tabbar" role="tablist" bind:this={bar}>
  {#each $tabs as t (t.id)}
    <div
      role="tab"
      tabindex="0"
      aria-selected={$active === t.id}
      data-sid={t.id}
      class="tab"
      class:active={$active === t.id}
      on:click={() => tabs.setActive(t.id)}
      on:keydown={(e) => e.key === 'Enter' && tabs.setActive(t.id)}
      on:auxclick={(e) => e.button === 1 && onClose(t.id)}
      title={t.title}
    >
      <span class="dot" class:busy={t.busy} class:dirty={t.dirty && !t.busy} class:ask={askSet.has(t.id)}></span>
      <span class="label">{t.title || t.id.slice(0, 12)}</span>
      <button class="x" title="Close (Ctrl+W)" on:click|stopPropagation={() => onClose(t.id)}
        >×</button
      >
    </div>
  {/each}
  <button class="add" title="New chat (Ctrl+T)" on:click={onNewChat}>+</button>
</div>

<style>
  .tabbar {
    display: flex;
    align-items: stretch;
    background: var(--bg-panel);
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
    scrollbar-width: thin;
  }
  .tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 8px 7px 12px;
    max-width: 220px;
    border-right: 1px solid var(--border);
    cursor: pointer;
    color: var(--fg-dim);
    font-size: 12.5px;
    user-select: none;
    flex-shrink: 0;
  }
  .tab.active {
    background: var(--bg);
    color: var(--fg);
    box-shadow: inset 0 2px 0 var(--accent);
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: transparent;
    flex-shrink: 0;
  }
  .dot.busy {
    background: var(--warn);
  }
  .dot.dirty {
    background: var(--ok);
  }
  /* source order = precedence: ask > busy > dirty */
  .dot.ask {
    background: var(--err);
  }
  .label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .x {
    background: transparent;
    border: none;
    color: inherit;
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
    padding: 0 2px;
    border-radius: 4px;
    opacity: 0.5;
  }
  .x:hover {
    opacity: 1;
    background: var(--bg-hover);
  }
  .add {
    background: transparent;
    border: none;
    color: var(--fg-dim);
    font-size: 16px;
    padding: 0 12px;
    cursor: pointer;
  }
  .add:hover {
    color: var(--fg);
    background: var(--bg-hover);
  }
</style>
