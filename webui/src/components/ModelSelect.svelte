<script lang="ts">
  import { onMount } from 'svelte'
  import { oc } from '../lib/api'
  import { selectedModel, sessionModels, sessionSyncedModels, setSessionModel, setSessionVariant, preferredDefaultModel, extractVariants, type VariantMap } from '../lib/stores'

  // Compact native-select model picker for the new-session empty state.
  // Reads the same precedence chain as ComposerModelPicker (this session's
  // pick > the engine's session model > global) and writes the same stores,
  // so the two views stay in sync — a change here is a change for the next
  // message in THIS session, not just a global default.
  export let sid = ''
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

  $: eff = (sid ? $sessionModels[sid] ?? $sessionSyncedModels[sid] : undefined) ?? $selectedModel
  $: value = eff ? `${eff.providerID}/${eff.modelID}` : ''
  $: modelKey = eff ? `${eff.providerID}/${eff.modelID}` : ''
  $: variants = modelKey ? variantMap[modelKey] ?? [] : []
  $: variantValue = eff?.variant ?? ''

  function save(ref: { providerID: string; modelID: string; variant?: string }) {
    selectedModel.save(ref)
    if (!sid) return
    setSessionModel(sid, ref)
    oc.setSessionModel(sid, ref).catch(() => {})
  }

  function change() {
    const [providerID, modelID] = value.split('/')
    if (providerID && modelID) {
      const cur = eff?.variant
      // Keep variant only if it's still valid for the new model
      const valid = cur && variantMap[`${providerID}/${modelID}`]?.some((v) => v.id === cur)
      save({ providerID, modelID, ...(valid ? { variant: cur } : {}) })
    }
  }

  function changeVariant(e: Event) {
    if (!eff) return
    const val = (e.target as HTMLSelectElement).value || undefined
    save({ ...eff, variant: val })
    if (sid) setSessionVariant(sid, val)
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
    max-width: 100%;
    flex-wrap: wrap;
    justify-content: center;
    justify-content: safe center;
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
    max-width: 100%;
    box-sizing: border-box;
    min-width: 0;
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
    max-width: min(300px, 100%);
    min-width: 0;
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
