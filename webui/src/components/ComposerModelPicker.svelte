<script lang="ts">
  import { onMount } from 'svelte'
  import { oc } from '../lib/api'
  import { selectedModel, recentModels, recordRecent, preferredDefaultModel, sessionModels, setSessionModel } from '../lib/stores'
  import type { ModelRef } from '../lib/stores'

  // Per-session model pick — scoped to THIS pane's tab/session.
  export let sid: string

  let providers: { id: string; name?: string; models: Record<string, any> }[] = []
  let open = false
  let wrap: HTMLDivElement

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

  // Sectioned list: "Recent" at the top (in recency order), then provider-grouped
  // sections for all non-recent models (alphabetical within each group).
  $: sections = (() => {
    const all: ModelItem[] = providers.flatMap((p) =>
      Object.values(p.models ?? {}).map((m) => ({
        pid: p.id,
        pname: p.name ?? p.id,
        mid: m.id,
        mname: m.name ?? m.id,
      })),
    )

    const recentKeys = new Set($recentModels.map((r) => r.providerID + '/' + r.modelID))

    const recentItems: ModelItem[] = []
    const recentSeen = new Set<string>()
    for (const r of $recentModels) {
      const key = r.providerID + '/' + r.modelID
      if (recentSeen.has(key)) continue
      recentSeen.add(key)
      const item = all.find((it) => it.pid === r.providerID && it.mid === r.modelID)
      if (item) recentItems.push(item)
    }

    const providerGroups = new Map<string, ModelItem[]>()
    for (const it of all) {
      if (recentKeys.has(it.pid + '/' + it.mid)) continue
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
    const ref: ModelRef = { providerID: pid, modelID: mid }
    recordRecent(ref)
    setSessionModel(sid, ref)
    open = false
  }

  function onOutside(e: PointerEvent) {
    if (!open || !wrap) return
    if (!wrap.contains(e.target as Node)) open = false
  }

  function onKeydown(e: KeyboardEvent) {
    if (open && e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      open = false
    }
  }
</script>

<svelte:window on:pointerdown={onOutside} on:keydown={onKeydown} />

<div class="wrap" bind:this={wrap}>
  <button class="cur" class:open title="Model for next message" on:click={() => (open = !open)}>
    <span class="lbl">{curLabel}</span>
    <span class="chev">▾</span>
  </button>
  {#if open}
    <div class="menu">
      {#each sections as sec (sec.label)}
        <div class="sec-head">{sec.label}</div>
        {#each sec.items as m (m.pid + '/' + m.mid)}
          <button
            class="m"
            class:on={$selectedModel?.providerID === m.pid && $selectedModel?.modelID === m.mid}
            on:click={() => pick(m.pid, m.mid)}
          >
            <span class="nm">{m.mname}</span>
            <span class="pv">{m.pname}</span>
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
    display: inline-flex;
    margin: 0 auto;
    padding: 0 4px 4px;
    max-width: 892px;
    width: 100%;
    box-sizing: border-box;
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
