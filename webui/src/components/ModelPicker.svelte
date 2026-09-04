<script lang="ts">
  import { onMount } from 'svelte'
  import { oc } from '../lib/api'
  import { selectedModel, modelPickerOpen, tabs, preferredDefaultModel, recentModels, recordRecent, extractVariants, type VariantMap } from '../lib/stores'

  let providers: { id: string; name?: string; models: Record<string, any> }[] = []
  let open = false
  let variantMap: VariantMap = {}
  let pickedModel: { pid: string; mid: string } | null = null

  interface ModelItem {
    pid: string
    pname: string
    mid: string
    mname: string
  }

  interface ModelSection {
    label: string
    items: ModelItem[]
  }

  const RECENT_LIMIT = 6

  // Sectioned list: "Recent" at the top (in recency order, max 6), then
  // provider-grouped sections for ALL models (alphabetical within each group).
  $: sections = (() => {
    const all: ModelItem[] = providers.flatMap((p) =>
      Object.values(p.models ?? {}).map((m) => ({
        pid: p.id,
        pname: p.name ?? p.id,
        mid: m.id,
        mname: m.name ?? m.id,
      })),
    )

    const recentItems: ModelItem[] = []
    const recentSeen = new Set<string>()
    for (const r of $recentModels) {
      if (recentItems.length >= RECENT_LIMIT) break
      const key = r.providerID + '/' + r.modelID
      if (recentSeen.has(key)) continue
      recentSeen.add(key)
      const item = all.find((it) => it.pid === r.providerID && it.mid === r.modelID)
      if (item) recentItems.push(item)
    }

    const providerGroups = new Map<string, ModelItem[]>()
    for (const it of all) {
      const arr = providerGroups.get(it.pid) ?? []
      arr.push(it)
      providerGroups.set(it.pid, arr)
    }

    const providerSections: ModelSection[] = []
    for (const [pid, items] of providerGroups) {
      items.sort((a, b) => a.mname.localeCompare(b.mname))
      const pname = items[0]?.pname ?? pid
      providerSections.push({ label: pname, items })
    }
    providerSections.sort((a, b) => a.label.localeCompare(b.label))

    const result: ModelSection[] = []
    if (recentItems.length) result.push({ label: 'Recent', items: recentItems })
    result.push(...providerSections)
    return result
  })()

  // Variants available for the currently picked model
  $: modelVariants = pickedModel ? variantMap[`${pickedModel.pid}/${pickedModel.mid}`] ?? [] : []

  onMount(async () => {
    await load()
    if (!$selectedModel && providers.length) {
      const def = preferredDefaultModel(providers)
      if (def) selectedModel.save(def)
    }
  })

  async function load() {
    if (!providers.length) {
      providers = await oc.providers().catch(() => [])
      variantMap = extractVariants(providers)
    }
  }

  // /models and the command palette can trigger the picker externally
  $: if ($modelPickerOpen) {
    modelPickerOpen.set(false)
    load().then(() => (open = true))
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && open) {
      if (pickedModel) { pickedModel = null; return }
      open = false
    }
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
    // If model has variants, show variant sub-selector instead of picking immediately
    const variants = variantMap[`${pid}/${mid}`]
    if (variants?.length) {
      pickedModel = { pid, mid }
      return
    }
    recordRecent({ providerID: pid, modelID: mid })
    selectedModel.save({ providerID: pid, modelID: mid })
    const sid = tabs.getActive()
    if (sid) oc.setSessionModel(sid, { providerID: pid, modelID: mid }).catch(() => {})
    open = false
  }

  function pickVariant(variant: string) {
    if (!pickedModel) return
    recordRecent({ providerID: pickedModel.pid, modelID: pickedModel.mid, variant })
    selectedModel.save({ providerID: pickedModel.pid, modelID: pickedModel.mid, variant })
    const sid = tabs.getActive()
    if (sid) oc.setSessionModel(sid, { providerID: pickedModel.pid, modelID: pickedModel.mid, variant }).catch(() => {})
    pickedModel = null
    open = false
  }

  function clearVariant() {
    if (!pickedModel) return
    // Pick the model without a variant
    recordRecent({ providerID: pickedModel.pid, modelID: pickedModel.mid })
    selectedModel.save({ providerID: pickedModel.pid, modelID: pickedModel.mid })
    const sid = tabs.getActive()
    if (sid) oc.setSessionModel(sid, { providerID: pickedModel.pid, modelID: pickedModel.mid }).catch(() => {})
    pickedModel = null
    open = false
  }
</script>

<svelte:window on:keydown={onKey} />

<div class="wrap">
  <button class="cur" title="Select model" on:click={() => { pickedModel = null; open = !open }}>
    {curLabel} ▾
  </button>
  {#if open}
    <div class="menu">
      {#if pickedModel && modelVariants.length}
        <!-- Variant sub-selector -->
        <div class="sec-head">thinking level</div>
        <button class="m back" on:click={() => (pickedModel = null)}>
          <span class="nm">← back to models</span>
        </button>
        {#each modelVariants as v (v.id)}
          <button
            class="m"
            on:click={() => pickVariant(v.id)}
          >
            <span class="nm">{v.label}</span>
          </button>
        {/each}
        <button class="m variant-clear" on:click={clearVariant}>
          <span class="nm">no thinking override</span>
        </button>
      {:else}
        {#each sections as sec (sec.label)}
          <div class="sec-head">{sec.label}</div>
          {#each sec.items as m (m.pid + '/' + m.mid)}
            <button
              class="m"
              class:on={$selectedModel?.providerID === m.pid && $selectedModel?.modelID === m.mid}
              on:click={() => pick(m.pid, m.mid)}
            >
              <span class="left"><span class="nm">{m.mname}</span>{#if variantMap[m.pid + '/' + m.mid]?.length}<span class="vbadge">⚙</span>{/if}</span>
              <span class="pv">{m.pname}</span>
            </button>
          {/each}
        {:else}
          <div class="none">engine unreachable</div>
        {/each}
      {/if}
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
  /* keep menu fully visible on narrow viewports */
  @media (max-width: 480px) {
    .menu {
      right: auto;
      left: 50%;
      transform: translateX(-50%);
      min-width: 0;
      max-width: calc(100vw - 16px);
      width: max-content;
    }
    .pv {
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100px;
    }
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
  .left {
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
    min-width: 0;
    overflow: hidden;
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
  .sec-head {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--fg-dim);
    padding: 8px 10px 3px;
    margin-top: 4px;
    border-top: 1px solid var(--border);
    user-select: none;
  }
  .sec-head:first-child {
    margin-top: 0;
    border-top: none;
  }
  .vbadge {
    font-size: 10px;
    color: var(--fg-dim);
    flex-shrink: 0;
    opacity: 0.6;
  }
  .back {
    color: var(--fg-dim);
    font-size: 11.5px;
  }
  .back:hover {
    color: var(--fg);
  }
  .variant-clear {
    color: var(--fg-dim);
    font-size: 11px;
    font-style: italic;
    border-top: 1px solid var(--border);
    margin-top: 4px;
    padding-top: 8px;
  }
</style>
