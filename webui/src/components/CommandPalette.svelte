<script lang="ts">
  import { tick } from 'svelte'
  import { paletteOpen } from '../lib/stores'
  import { registry, runBuiltin, SUGGESTED, type Cmd } from '../lib/commands'

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

  // Builtins only — engine custom commands/skills stay in the composer "/"
  // menu (registry.all()) but the palette mirrors the TUI's built-in list.
  // registry.builtins is a module constant, so a one-time derivation is safe
  // here (no cmdVersion dependency needed).
  const cmds: Cmd[] = registry.builtins

  const CAT_ORDER = ['Session', 'Agent', 'Model', 'View', 'System']

  interface Section {
    header: string
    rows: Cmd[]
    start: number // index of rows[0] within `flat`
  }

  function normCat(c: Cmd): string {
    return c.category && CAT_ORDER.includes(c.category) ? c.category : 'System'
  }

  function haystack(c: Cmd): string {
    return [c.title ?? '', c.name, c.description, c.category ?? ''].join(' ').toLowerCase()
  }

  function match(q: string): Cmd[] {
    const ql = q.trim().toLowerCase()
    const words = ql.split(/\s+/).filter(Boolean)
    if (!words.length) return cmds
    return cmds.filter((c) => {
      const hay = haystack(c)
      return words.every((w) => hay.includes(w))
    })
  }

  // Empty query → "Suggested" section + category groups (TUI parity).
  // Non-empty → ONE flat filtered list with no headers (the TUI drops its
  // suggestions as soon as you filter). Both structures share one derivation
  // so `sel` can span the flattened visible rows.
  $: view = buildView(query)
  function buildView(q: string): { sections: Section[]; flat: Cmd[] } {
    const filtered = match(q)
    if (q.trim()) return { sections: [], flat: filtered }
    const sections: Section[] = []
    const suggested = SUGGESTED.map((n) => cmds.find((c) => c.name === n)).filter(
      (c): c is Cmd => !!c,
    )
    sections.push({ header: 'Suggested', rows: suggested, start: 0 })
    let start = suggested.length
    // TUI parity: the TUI lists suggestions first and then the FULL command
    // list again under its natural grouping — suggested entries are NOT
    // removed from their category (dropping them made Agent/Model vanish,
    // since both categories consist entirely of suggested commands).
    const rest = cmds
    for (const cat of CAT_ORDER) {
      const rows = rest.filter((c) => normCat(c) === cat)
      if (!rows.length) continue
      sections.push({ header: cat, rows, start })
      start += rows.length
    }
    return { sections, flat: [...suggested, ...rest] }
  }

  // keep keyboard selection in view
  $: if (listEl && view.flat[sel]) {
    tick().then(() => listEl.querySelector('.row.active')?.scrollIntoView({ block: 'nearest' }))
  }

  $: if (sel >= view.flat.length) sel = Math.max(0, view.flat.length - 1)

  function close() {
    paletteOpen.set(false)
    onDone()
  }

  async function run(c: Cmd) {
    close()
    await runBuiltin(c.name)
  }

  // Window-level Escape handler — the input-only binding misses Escape when
  // focus drifts (e.g. after a concurrent blur-on-Escape handler fires).
  // Every other dialog in the app uses <svelte:window> for this.
  function onWindowKey(e: KeyboardEvent) {
    if ($paletteOpen && e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  }

  function key(e: KeyboardEvent) {
    if (e.key === 'Escape') close()
    else if (e.key === 'ArrowDown') {
      e.preventDefault()
      sel = Math.min(sel + 1, view.flat.length - 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      sel = Math.max(sel - 1, 0)
    } else if (e.key === 'Enter' && view.flat[sel]) {
      e.preventDefault()
      run(view.flat[sel])
    }
  }
</script>

<svelte:window on:keydown={onWindowKey} />

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
        {#if query.trim()}
          {#each view.flat as c, i (c.name)}
            <button
              class="row"
              class:active={i === sel}
              on:click={() => run(c)}
              on:mousemove={() => (sel = i)}
            >
              <span class="title">{c.title ?? c.name}</span>
              <span class="desc">{c.description}</span>
              {#if c.keybind}<span class="hint">{c.keybind}</span>{/if}
            </button>
          {:else}
            <div class="none">no matching command</div>
          {/each}
        {:else}
          {#each view.sections as s (s.header)}
            <div class="sechead">{s.header}</div>
            {#each s.rows as c, i (`${s.header}/${c.name}`)}
              <button
                class="row"
                class:active={s.start + i === sel}
                on:click={() => run(c)}
                on:mousemove={() => (sel = s.start + i)}
              >
                <span class="title">{c.title ?? c.name}</span>
                {#if c.description && c.description !== (c.title ?? c.name)}<span class="desc">{c.description}</span>{/if}
                {#if c.keybind}<span class="hint">{c.keybind}</span>{/if}
              </button>
            {/each}
          {/each}
        {/if}
      </div>
      <div class="foot">↑↓ navigate · ↵ run · esc close · ctrl+x chords</div>
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
  .sechead {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 8px 10px 2px;
    color: var(--fg-dim);
    user-select: none;
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
  .title {
    color: var(--fg);
    font-size: 13px;
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
  .hint {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--fg-dim);
    flex-shrink: 0;
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
