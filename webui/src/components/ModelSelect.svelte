<script lang="ts">
  import { onMount } from 'svelte'
  import { oc } from '../lib/api'
  import { selectedModel } from '../lib/stores'

  // Compact native-select model picker for the new-session empty state.
  // Same store as the topbar ModelPicker — both views stay in sync because
  // they read/write the same persisted selection.
  let providers: { id: string; name?: string; models: Record<string, any> }[] = []

  onMount(async () => {
    providers = await oc.providers().catch(() => [])
    if (!$selectedModel && providers.length) {
      const p = providers[0]
      const first = Object.keys(p.models ?? {})[0]
      if (first) selectedModel.save({ providerID: p.id, modelID: first })
    }
  })

  $: value = $selectedModel ? `${$selectedModel.providerID}/${$selectedModel.modelID}` : ''

  function change() {
    const [providerID, modelID] = value.split('/')
    if (providerID && modelID) selectedModel.save({ providerID, modelID })
  }

  function short(name: string): string {
    return name.length > 34 ? name.slice(0, 32) + '…' : name
  }
</script>

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

<style>
  .msel {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    margin-top: 14px;
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
</style>
