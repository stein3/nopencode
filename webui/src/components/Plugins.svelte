<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { pluginsOpen, closePlugins, toast } from '../lib/stores'
  import { oc } from '../lib/api'

  interface Plugin {
    name: string
    description: string
    category: 'external' | 'internal'
    active: boolean
  }

  let plugins: Plugin[] = []
  let loading = true
  let query = ''
  let sel = 0
  let inputEl: HTMLInputElement
  let listEl: HTMLElement
  let pluginList: string[] = []
  let toggling: Record<string, boolean> = {}

  async function loadPlugins() {
    loading = true
    try {
      const [config, agents, skills] = await Promise.all([
        oc.path().catch(() => ({})),
        oc.agents().catch(() => []),
        oc.skills().catch(() => []),
      ])

      const result: Plugin[] = []

      // External plugins from config
      try {
        const cfg = await fetch('/oc/config').then(r => r.json())
        pluginList = cfg.plugin ?? []
        for (const p of pluginList) {
          // Extract short name from spec (e.g. "oh-my-opencode-slim" or "git+https://..." → "lemonade-watcher")
          const shortName = p.includes('/') ? p.split('/').pop()?.replace(/\.git$/, '') ?? p : p
          result.push({
            name: shortName,
            description: shortName,
            category: 'external',
            active: true, // loaded = active
          })
        }
      } catch {}

      // Internal plugins derived from agents (native=true = built-in)
      for (const a of agents) {
        if (a.mode === 'subagent' || a.hidden) continue
        const native = (a as any).native !== false
        if (native) {
          result.push({
            name: a.name,
            description: 'Built-in plugin',
            category: 'internal',
            active: true,
          })
        }
      }

      // Internal plugins from skills (built-in)
      for (const s of skills) {
        if (s.location === '<built-in>') {
          result.push({
            name: s.name,
            description: 'Built-in plugin',
            category: 'internal',
            active: true,
          })
        }
      }

      // Dedupe by name
      const seen = new Set<string>()
      plugins = result.filter(p => {
        if (seen.has(p.name)) return false
        seen.add(p.name)
        return true
      })
    } catch {
      plugins = []
    }
    loading = false
  }

  function close() {
    pluginsOpen.set(false)
    closePlugins()
  }

  function onWindowKey(e: KeyboardEvent) {
    if ($pluginsOpen && e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
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
    } else if (e.key === ' ') {
      e.preventDefault()
      const p = filtered[sel]
      if (p) togglePlugin(p.name)
    }
  }

  $: if ($pluginsOpen) {
    query = ''
    sel = 0
    loadPlugins()
    tick().then(() => inputEl?.focus())
  }

  $: filtered = plugins.filter(p => {
    if (!query.trim()) return true
    const ql = query.toLowerCase()
    return p.name.toLowerCase().includes(ql) || p.description.toLowerCase().includes(ql)
  })

  $: external = filtered.filter(p => p.category === 'external')
  $: internal = filtered.filter(p => p.category === 'internal')

  $: if (listEl && filtered[sel]) {
    tick().then(() => listEl.querySelector('.row.active')?.scrollIntoView({ block: 'nearest' }))
  }

  $: if (sel >= filtered.length) sel = Math.max(0, filtered.length - 1)

  function shortName(name: string): string {
    // oh-my-opencode-slim:tui → oh-my-opencode-slim
    return name.split(':')[0]
  }

  function specForName(name: string): string | undefined {
    return pluginList.find(s => shortName(s) === name)
  }

  async function togglePlugin(name: string) {
    const plug = plugins.find(p => p.name === name)
    if (!plug || plug.category === 'internal') return
    toggling = { ...toggling, [name]: true }
    try {
      const cfg: any = await oc.config()
      const current: string[] = cfg.plugin ?? []
      const spec = specForName(name)
      let newList: string[]
      if (plug.active) {
        newList = current.filter((s: string) => shortName(s) !== name)
      } else {
        newList = [...current, spec || name]
      }
      await oc.configPatch({ plugin: newList })
      toast(`${name} ${plug.active ? 'disabled' : 'enabled'} — restart to apply`)
      // Flip the local state immediately for UI feedback
      plug.active = !plug.active
      pluginList = newList
      plugins = plugins // trigger reactivity
    } catch (e: any) {
      toast(`toggle failed: ${e.message ?? e}`)
    } finally {
      toggling = { ...toggling, [name]: false }
    }
  }
</script>

<svelte:window on:keydown={onWindowKey} />

{#if $pluginsOpen}
  <div class="overlay" role="presentation" on:mousedown={close}>
    <div class="panel" role="presentation" on:mousedown|stopPropagation>
      <div class="head">
        <span class="title">Plugins</span>
        <span class="esc">esc</span>
      </div>
      <div class="inputrow" role="presentation" on:mousedown|preventDefault={() => {}}>
        <span class="search-icon" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </span>
        <input
          bind:this={inputEl}
          bind:value={query}
          placeholder="search"
          spellcheck="false"
          autocomplete="off"
          on:keydown={key}
        />
      </div>
      <div class="list" bind:this={listEl}>
        {#if loading}
          <div class="empty">loading…</div>
        {:else}
          {#if external.length}
            <div class="sechead">External</div>
            {#each external as p, i (p.name)}
              <button
                class="row"
                class:active={filtered.indexOf(p) === sel}
                on:mousemove={() => (sel = filtered.indexOf(p))}
              >
                <span class="bullet" aria-hidden="true">{filtered.indexOf(p) === sel ? '•' : ' '}</span>
                <span class="pname">{shortName(p.name)}</span>
                <span class="pdesc">{p.description}</span>
                <span class="pstatus" class:active={p.active}>{p.active ? 'active' : 'disabled'}</span>
              </button>
            {/each}
          {/if}
          {#if internal.length}
            <div class="sechead">Internal</div>
            {#each internal as p, i (p.name)}
              <button
                class="row"
                class:active={filtered.indexOf(p) === sel}
                on:mousemove={() => (sel = filtered.indexOf(p))}
              >
                <span class="bullet" aria-hidden="true">{filtered.indexOf(p) === sel ? '•' : ' '}</span>
                <span class="pname">{shortName(p.name)}</span>
                <span class="pdesc">{p.description}</span>
                <span class="pstatus" class:active={p.active}>{p.active ? 'active' : 'disabled'}</span>
              </button>
            {/each}
          {/if}
          {#if !external.length && !internal.length}
            <div class="empty">No plugins found</div>
          {/if}
        {/if}
      </div>
      <div class="foot">
        <span class="action"><b>toggle</b> <span class="key">space</span></span>
        <span class="action"><b>install</b> <span class="key">shift+i</span></span>
      </div>
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
    width: min(600px, 92vw);
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px 0;
  }
  .title {
    font-weight: 600;
    font-size: 14px;
    color: var(--fg);
  }
  .esc {
    font-size: 11px;
    color: var(--fg-dim);
    background: var(--bg-hover);
    padding: 2px 6px;
    border-radius: 4px;
  }
  .inputrow {
    display: flex;
    align-items: center;
    border-bottom: 1px solid var(--border);
    cursor: text;
    padding: 0 12px;
  }
  .search-icon {
    color: var(--fg-dim);
    flex-shrink: 0;
    display: flex;
    align-items: center;
  }
  input {
    width: 100%;
    box-sizing: border-box;
    background: transparent;
    color: var(--fg);
    border: none;
    outline: none;
    padding: 10px 8px;
    font-size: 13px;
  }
  .list {
    max-height: 50vh;
    overflow-y: auto;
    padding: 4px 0;
  }
  .sechead {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 10px 16px 4px;
    color: var(--accent);
    user-select: none;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: 0;
    color: var(--fg);
    padding: 6px 16px;
    cursor: pointer;
    font-size: 13px;
  }
  .row.active {
    background: var(--bg-hover);
  }
  .bullet {
    width: 12px;
    text-align: center;
    flex-shrink: 0;
    color: var(--accent);
    font-size: 14px;
  }
  .pname {
    font-weight: 500;
    white-space: nowrap;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pdesc {
    flex: 1;
    color: var(--fg-dim);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    /* dotted leader like TUI */
    border-bottom: 1px dotted var(--border);
    margin: 0 4px;
    min-width: 20px;
  }
  .pstatus {
    font-size: 11px;
    color: var(--fg-dim);
    flex-shrink: 0;
    white-space: nowrap;
  }
  .pstatus.active {
    color: var(--ok);
  }
  .empty {
    padding: 16px;
    color: var(--fg-dim);
    font-size: 12.5px;
    text-align: center;
  }
  .foot {
    border-top: 1px solid var(--border);
    padding: 8px 16px;
    display: flex;
    gap: 20px;
    font-size: 11px;
    color: var(--fg-dim);
    user-select: none;
  }
  .action b {
    color: var(--fg);
    font-weight: 500;
  }
  .action .key {
    color: var(--fg-dim);
    margin-left: 4px;
  }
</style>
