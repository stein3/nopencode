<script lang="ts">
  import { onMount } from 'svelte'
  import { oc } from '../lib/api'
  import { selectedModel, modelPickerOpen, tabs, preferredDefaultModel, recentModels, recordRecent } from '../lib/stores'

  let providers: { id: string; name?: string; models: Record<string, any> }[] = []
  let open = false

  interface FlatModel {
    pid: string
    pname: string
    mid: string
    mname: string
    recentIdx: number
  }

  // flat across providers: most recently used first (in recency order), then
  // never-used models alphabetically. stale recents sink into the alpha tail.
  // reads $recentModels (a store) so the list re-sorts immediately after each pick —
  // a plain localStorage read here would be invisible to the compiler (frozen-label bug)
  $: flat = (() => {
    const items: FlatModel[] = providers.flatMap((p) =>
      Object.values(p.models ?? {}).map((m) => ({
        pid: p.id,
        pname: p.name ?? p.id,
        mid: m.id,
        mname: m.name ?? m.id,
        recentIdx: -1,
      })),
    )
    const rank = new Map<string, number>()
    $recentModels.forEach((r, i) => rank.set(r.providerID + '/' + r.modelID, i))
    for (const it of items) {
      const r = rank.get(it.pid + '/' + it.mid)
      if (r !== undefined) it.recentIdx = r
    }
    return items.sort(
      (a, b) =>
        (a.recentIdx === -1 ? Infinity : a.recentIdx) - (b.recentIdx === -1 ? Infinity : b.recentIdx) ||
        a.mname.localeCompare(b.mname),
    )
  })()

  onMount(async () => {
    await load()
    if (!$selectedModel && providers.length) {
      const def = preferredDefaultModel(providers)
      if (def) selectedModel.save(def)
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
    recordRecent({ providerID: pid, modelID: mid })
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
      {#each flat as m (m.pid + '/' + m.mid)}
        <button
          class="m"
          class:on={$selectedModel?.providerID === m.pid && $selectedModel?.modelID === m.mid}
          on:click={() => pick(m.pid, m.mid)}
        >
          <span class="nm">{m.mname}</span>
          <span class="pv">{m.pname}</span>
        </button>
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
  .m {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
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
  }
  .nm {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .pv {
    font-size: 10px;
    color: var(--fg-dim);
    white-space: nowrap;
    flex-shrink: 0;
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
