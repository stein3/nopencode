<script lang="ts">
  import { onMount } from 'svelte'
  import { oc } from '../lib/api'
  import { selectedModel, recentModels, recordRecent, preferredDefaultModel, sessionModels, setSessionModel, sessionVariants, setSessionVariant, modelPickerOpen, extractVariants, type VariantMap } from '../lib/stores'
  import type { ModelRef } from '../lib/stores'

  // Per-session model pick — scoped to THIS pane's tab/session.
  export let sid: string

  let providers: { id: string; name?: string; models: Record<string, any> }[] = []
  let open = false
  let wrap: HTMLDivElement
  let variantMap: VariantMap = {}
  let pickedModel: { pid: string; mid: string } | null = null
  let highlighted = -1
  let menuEl: HTMLDivElement | null = null

  // ctrl+x m chord sets this store — consume it to open the picker
  modelPickerOpen.subscribe((v) => { if (v) { pickedModel = null; open = true; modelPickerOpen.set(false) } })

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

  // The effective model for this session: per-session pick > global picker > null
  $: effective = $sessionModels[sid] ?? $selectedModel

  // Variants available for the currently picked model
  $: modelVariants = pickedModel ? variantMap[`${pickedModel.pid}/${pickedModel.mid}`] ?? [] : []

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

  onMount(async () => {
    providers = await oc.providers().catch(() => [])
    variantMap = extractVariants(providers)
    if (!$selectedModel && providers.length) {
      const def = preferredDefaultModel(providers)
      if (def) selectedModel.save(def)
    }
  })

  // Reactive label — must be a statement, not a template function (frozen-label bug)
  $: curLabel = labelFor(effective, providers)

  function labelFor(m: ModelRef | null, provs: typeof providers): string {
    if (!m) return 'model…'
    const prov = provs.find((p) => p.id === m.providerID)
    const name = prov?.models?.[m.modelID]?.name ?? m.modelID
    return name.length > 22 ? name.slice(0, 20) + '…' : name
  }

  function pick(pid: string, mid: string) {
    // If model has variants, show variant sub-selector instead of picking immediately
    const variants = variantMap[`${pid}/${mid}`]
    if (variants?.length) {
      pickedModel = { pid, mid }
      return
    }
    const ref: ModelRef = { providerID: pid, modelID: mid }
    recordRecent(ref)
    selectedModel.save(ref)
    setSessionModel(sid, ref)
    if (sid) oc.setSessionModel(sid, ref).catch(() => {})
    open = false
  }

  function pickVariant(variant: string) {
    if (!pickedModel) return
    const ref: ModelRef = { providerID: pickedModel.pid, modelID: pickedModel.mid, variant }
    recordRecent(ref)
    selectedModel.save(ref)
    setSessionModel(sid, ref)
    setSessionVariant(sid, variant)
    if (sid) oc.setSessionModel(sid, ref).catch(() => {})
    pickedModel = null
    open = false
  }

  function clearVariant() {
    if (!pickedModel) return
    const ref: ModelRef = { providerID: pickedModel.pid, modelID: pickedModel.mid }
    recordRecent(ref)
    selectedModel.save(ref)
    setSessionModel(sid, ref)
    setSessionVariant(sid, undefined)
    if (sid) oc.setSessionModel(sid, ref).catch(() => {})
    pickedModel = null
    open = false
  }

  function onOutside(e: PointerEvent) {
    if (!open || !wrap) return
    if (!wrap.contains(e.target as Node)) open = false
  }

  // Reset highlight when menu opens or switches to variant view
  $: if (open || pickedModel !== null) highlighted = -1

  // Flat index for section view: cumulative offset across sections
  function flatIdx(secIdx: number, itemIdx: number): number {
    let offset = 0
    for (let i = 0; i < secIdx; i++) offset += sections[i].items.length
    return offset + itemIdx
  }

  function menuItems(): HTMLElement[] {
    const el: any = menuEl
    return el ? [...el.querySelectorAll('.m:not(.back)')] as HTMLElement[] : []
  }

  function highlightNext() {
    const items = menuItems()
    if (!items.length) return
    highlighted = highlighted < items.length - 1 ? highlighted + 1 : 0
    items[highlighted]?.scrollIntoView({ block: 'nearest' })
  }

  function highlightPrev() {
    const items = menuItems()
    if (!items.length) return
    highlighted = highlighted > 0 ? highlighted - 1 : items.length - 1
    items[highlighted]?.scrollIntoView({ block: 'nearest' })
  }

  function activateHighlighted() {
    const items = menuItems()
    if (highlighted >= 0 && highlighted < items.length) {
      items[highlighted].click()
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (!open) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      open = false
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      e.stopPropagation()
      highlightNext()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      highlightPrev()
    } else if (e.key === 'Enter' && highlighted >= 0) {
      e.preventDefault()
      e.stopPropagation()
      activateHighlighted()
    }
  }

  onMount(() => {
    // Use capture-phase listener so this fires BEFORE the sidebar's bubble-phase handler
    const handler = (e: KeyboardEvent) => onKeydown(e)
    window.addEventListener('keydown', handler, { capture: true })
    return () => window.removeEventListener('keydown', handler)
  })
</script>

<svelte:window on:pointerdown={onOutside} />

<div class="wrap" bind:this={wrap}>
  <button class="cur" class:open title="Model for next message" on:click={() => { pickedModel = null; open = !open }}>
    <span class="lbl">{curLabel}</span>
    <span class="chev">▾</span>
  </button>
  {#if open}
    <div class="menu" bind:this={menuEl}>
      {#if pickedModel && modelVariants.length}
        <!-- Variant sub-selector -->
        <div class="sec-head">thinking level</div>
        <button class="m back" on:click={() => (pickedModel = null)}>
          <span class="nm">← back to models</span>
        </button>
        {#each modelVariants as v (v.id)}
          <button
            class="m"
            class:hl={modelVariants.indexOf(v) === highlighted}
            on:click={() => pickVariant(v.id)}
          >
            <span class="nm">{v.label}</span>
          </button>
        {/each}
        <button class="m variant-clear" class:hl={modelVariants.length === highlighted} on:click={clearVariant}>
          <span class="nm">no thinking override</span>
        </button>
      {:else}
        {#each sections as sec, secIdx (sec.label)}
          <div class="sec-head">{sec.label}</div>
          {#each sec.items as m, itemIdx (m.pid + '/' + m.mid)}
            <button
              class="m"
              class:on={$selectedModel?.providerID === m.pid && $selectedModel?.modelID === m.mid}
              class:hl={flatIdx(secIdx, itemIdx) === highlighted}
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
    display: inline-flex;
    align-self: center;
  }
  .cur {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--fg-dim);
    border-radius: 6px;
    font-size: 11px;
    padding: 2px 8px;
    cursor: pointer;
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cur:hover {
    color: var(--fg);
    border-color: var(--accent);
  }
  .cur.open {
    border-color: var(--accent);
    color: var(--fg);
  }
  .cur.open .chev {
    transform: rotate(180deg);
  }
  .lbl {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chev {
    flex-shrink: 0;
    opacity: 0.7;
    font-size: 9px;
  }
  /* opens UPWARD — composer sits at viewport bottom (AgentPicker precedent) */
  .menu {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 4px;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    min-width: 240px;
    max-height: 40vh;
    overflow-y: auto;
    z-index: 80;
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
    font-size: 12px;
    padding: 5px 10px;
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
  .m.hl {
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
    margin: 0 5px
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
  @media (max-width: 480px) {
    .menu {
      left: auto;
      right: 4px;
      min-width: 0;
      max-width: calc(100vw - 16px);
      width: max-content;
    }
    .pv {
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 80px;
    }
  }
</style>
