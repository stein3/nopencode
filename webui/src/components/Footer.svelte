<script lang="ts">
  import { onMount } from 'svelte'
  import { oc } from '../lib/api'
  import { selectedModel, paletteOpen } from '../lib/stores'
  import type { Tab } from '../lib/stores'

  export let tab: Tab

  let dir = ''
  let cost = 0
  let usedTokens = 0 // context-window estimate from newest assistant message

  function fmtK(n: number): string {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
    if (n >= 1000) return Math.round(n / 1000) + '.' + Math.floor((n % 1000) / 100) + 'K'
    return String(n)
  }

  async function refresh() {
    try {
      const [sess, msgs, path] = await Promise.all([
        oc.session(tab.id),
        oc.messages(tab.id),
        dir ? Promise.resolve(null as any) : oc.path(),
      ])
      cost = sess?.cost ?? 0
      if (path?.directory && !dir) dir = path.directory
      // newest assistant message carries the live context tally
      const withTok = [...(msgs ?? [])]
        .reverse()
        .find((m: any) => ((m.info ?? m)?.role ?? 'assistant') === 'assistant' && (m.info ?? m)?.tokens)
      const t = withTok ? ((withTok.info ?? withTok).tokens ?? {}) : {}
      usedTokens =
        (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) +
        ((t.cache?.read ?? 0) + (t.cache?.write ?? 0))
    } catch {
      /* history-only tab or engine hiccup */
    }
  }

  $: if (tab.id || tab.busy === false) refresh(), void tab.busy

  let limit = 0
  onMount(async () => {
    const provs = await oc.providers().catch(() => [])
    const m = $selectedModel
    const prov = provs.find((p: any) => p.id === m?.providerID)
    limit = prov?.models?.[m?.modelID ?? '']?.limit?.context ?? 0
    if (!dir) dir = (await oc.path().catch(() => ({})))?.directory ?? ''
  })

  $: pct = limit ? Math.min(100, (usedTokens / limit) * 100) : 0
</script>

<div class="footer">
  <span class="seg" title="working directory">{dir || '~'}</span>
  {#if usedTokens}
    <span class="seg" title="estimated context usage">
      {fmtK(usedTokens)}{limit ? ` (${pct.toFixed(0)}%)` : ''}
    </span>
  {/if}
  {#if cost > 0}
    <span class="seg" title="session spend">${cost.toFixed(3)}</span>
  {/if}
  <div class="spacer"></div>
  <button class="cmd" title="Command palette" on:click={() => paletteOpen.set(true)}>
    ctrl+p commands
  </button>
</div>

<style>
  .footer {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 4px 18px 7px;
    max-width: 892px;
    margin: 0 auto;
    width: 100%;
    box-sizing: border-box;
    font-size: 11px;
    color: var(--fg-dim);
    user-select: none;
    min-height: 22px;
  }
  .seg {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .spacer {
    flex: 1;
  }
  .cmd {
    background: transparent;
    border: none;
    color: var(--fg-dim);
    font-size: 11px;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 4px;
    white-space: nowrap;
  }
  .cmd:hover {
    background: var(--bg-hover);
    color: var(--fg);
  }
</style>
