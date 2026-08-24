<script lang="ts">
  import { onMount } from 'svelte'
  import { oc } from '../lib/api'
  import { selectedModel, modelPickerOpen, tabs } from '../lib/stores'

  let providers: { id: string; name?: string; models: Record<string, any> }[] = []
  let open = false

  onMount(async () => {
    await load()
    if (!$selectedModel && providers.length) {
      const p = providers[0]
      const first = Object.keys(p.models ?? {})[0]
      if (first) selectedModel.save({ providerID: p.id, modelID: first })
    }
  })

  async function load() {
    if (!providers.length) providers = await oc.providers().catch(() => [])
  }

  // /models and the command palette can trigger the picker externally
  $: if ($modelPickerOpen) {
    modelPickerOpen.set(false)
    load().then(() => (open = true))
  }

  // must be a reactive statement, NOT a function called in the template —
  // `{label()}` never re-runs because the compiler can't see the stores/vars
  // read inside the function body (label stayed frozen on "model…"/raw id)
  $: curLabel = labelFor($selectedModel, providers)

  function labelFor(m: { providerID: string; modelID: string } | null, provs: typeof providers): string {
    if (!m) return 'model…'
    const prov = provs.find((p) => p.id === m.providerID)
    const name = prov?.models?.[m.modelID]?.name ?? m.modelID
    return name.length > 26 ? name.slice(0, 24) + '…' : name
  }

  function pick(pid: string, mid: string) {
    selectedModel.save({ providerID: pid, modelID: mid })
    // switch the open session right away, not just the next prompt
    const sid = tabs.getActive()
    if (sid) oc.setSessionModel(sid, { providerID: pid, modelID: mid }).catch(() => {})
    open = false
  }
</script>

<div class="wrap">
  <button class="cur" title="Select model" on:click={() => (open = !open)}>
    {curLabel} ▾
  </button>
  {#if open}
    <div class="menu">
      {#each providers as p (p.id)}
        <div class="prov">{p.name ?? p.id}</div>
        {#each Object.values(p.models ?? {}) as m (p.id + '/' + m.id)}
          <button
            class="m"
            class:on={$selectedModel?.providerID === p.id && $selectedModel?.modelID === m.id}
            on:click={() => pick(p.id, m.id)}
          >
            {m.name ?? m.id}
          </button>
        {/each}
      {:else}
        <div class="none">engine unreachable</div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .wrap {
    position: relative;
  }
  .cur {
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--fg-dim);
    border-radius: 6px;
    font-size: 11.5px;
    padding: 3px 9px;
    cursor: pointer;
    max-width: 240px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cur:hover {
    color: var(--fg);
    border-color: var(--accent);
  }
  .menu {
    position: absolute;
    right: 0;
    top: calc(100% + 6px);
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    min-width: 260px;
    max-height: 50vh;
    overflow-y: auto;
    z-index: 60;
    box-shadow: 0 14px 40px rgba(0, 0, 0, 0.5);
    padding: 4px;
  }
  .prov {
    font-size: 10.5px;
    color: var(--fg-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 7px 10px 3px;
  }
  .m {
    display: block;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    border-left: 2px solid transparent;
    border-radius: 5px;
    color: var(--fg);
    font-size: 12.5px;
    padding: 6px 10px;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .m:hover {
    background: var(--bg-hover);
  }
  .m.on {
    border-left-color: var(--accent);
    color: var(--accent);
  }
  .none {
    padding: 12px;
    color: var(--fg-dim);
    font-size: 12px;
  }
</style>
