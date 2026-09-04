<script lang="ts">
  import { onMount } from 'svelte'
  import { oc } from '../lib/api'
  import { selectedModel, preferredDefaultModel, extractVariants, type VariantMap } from '../lib/stores'

  // Compact native-select model picker for the new-session empty state.
  // Same store as the topbar ModelPicker — both views stay in sync because
  // they read/write the persisted selection.
  let providers: { id: string; name?: string; models: Record<string, any> }[] = []
  let variantMap: VariantMap = {}

  onMount(async () => {
    providers = await oc.providers().catch(() => [])
    variantMap = extractVariants(providers)
    if (!$selectedModel && providers.length) {
      const def = preferredDefaultModel(providers)
      if (def) selectedModel.save(def)
    }
  })

  $: value = $selectedModel ? `${$selectedModel.providerID}/${$selectedModel.modelID}` : ''
  $: modelKey = $selectedModel ? `${$selectedModel.providerID}/${$selectedModel.modelID}` : ''
  $: variants = modelKey ? variantMap[modelKey] ?? [] : []
  $: variantValue = $selectedModel?.variant ?? ''

  function change() {
    const [providerID, modelID] = value.split('/')
    if (providerID && modelID) {
      const cur = $selectedModel?.variant
      // Keep variant only if it's still valid for the new model
      const valid = cur && variantMap[`${providerID}/${modelID}`]?.some((v) => v.id === cur)
      selectedModel.save({ providerID, modelID, ...(valid ? { variant: cur } : {}) })
    }
  }

  function changeVariant(e: Event) {
    if (!$selectedModel) return
    const val = (e.target as HTMLSelectElement).value || undefined
    selectedModel.save({ ...$selectedModel, variant: val })
  }

  function short(name: string): string {
    return name.length > 34 ? name.slice(0, 32) + '…' : name
  }
</script>

<div class="msel-wrap">
  <label class="msel" title="Model used for your next message">
    <span class="lbl">model</span>
    <select bind:value={value} on:change={change}>
      {#if !value}
        <option value="" disabled>model…</option>
      {/if}
      {#each providers as p (p.id)}
        <optgroup label={p.name ?? p.id}>
          {#each Object.values(p.models ?? {}) as m (m.id)}
            <option value={`${p.id}/${m.id}`}>{short(m.name ?? m.id)}</option>
          {/each}
        </optgroup>
      {:else}
        <option value="">engine unreachable</option>
      {/each}
    </select>
  </label>
  {#if variants.length}
    <label class="msel varsel" title="Thinking level">
      <span class="lbl">think</span>
      <!-- svelte-ignore a11y-no-onchange -->
      <select value={variantValue} on:change={changeVariant}>
        <option value="">default</option>
        {#each variants as v (v.id)}
          <option value={v.id}>{v.label}</option>
        {/each}
      </select>
    </label>
  {/if}
</div>

<style>
  .msel-wrap {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 14px;
  }
  .msel {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 5px 10px;
    cursor: pointer;
  }
  .msel:hover {
    border-color: var(--accent);
  }
  .lbl {
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--fg-dim);
    user-select: none;
  }
  select {
    background: transparent;
    color: var(--fg);
    border: none;
    outline: none;
    font: inherit;
    font-size: 12.5px;
    max-width: 300px;
    cursor: pointer;
  }
  select option,
  select optgroup {
    background: var(--bg-panel);
    color: var(--fg);
  }
  .varsel {
    max-width: 160px;
  }
</style>
