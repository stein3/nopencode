<script lang="ts">
  import { onMount } from 'svelte'
  import { oc } from '../lib/api'
  import { RECENT_PAGE } from '../lib/sse'
  import { selectedModel, paletteOpen, sessionMetrics, metricsFromMessages } from '../lib/stores'
  import type { Tab } from '../lib/stores'

  export let tab: Tab

  let dir = ''
  let cost = 0
  // context-window estimate; live SSE tallies land in sessionMetrics and take
  // precedence — the fetched value covers sessions with no SSE traffic yet
  let fetchedTokens = 0

  function fmtK(n: number): string {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
    if (n >= 1000) return Math.round(n / 1000) + '.' + Math.floor((n % 1000) / 100) + 'K'
    return String(n)
  }

  async function refresh() {
    if (tab.pending) return // no session on the engine yet
    try {
      const [sess, msgs, path] = await Promise.all([
        oc.session(tab.id),
        oc.messages(tab.id, RECENT_PAGE),
        dir ? Promise.resolve(null as any) : oc.path(),
      ])
      cost = sess?.cost ?? 0
      if (path?.directory && !dir) dir = path.directory
      // newest assistant message with a NON-ZERO tally (aborted/empty turns
      // leave all-zero tokens objects behind — see tokenTally)
      fetchedTokens = metricsFromMessages(msgs ?? []).tokens ?? 0
    } catch {
      /* history-only tab or engine hiccup */
    }
  }

  // refetch only on meaningful transitions — tab objects are replaced on
  // every store patch (streaming included); refetching on each would cascade
  let lastKey = ''
  $: {
    const k = `${tab.id}:${tab.busy ? 1 : 0}`
    if (!tab.pending && (tab.id || tab.busy === false) && k !== lastKey) {
      lastKey = k
      refresh()
    }
  }

  let limit = 0
  onMount(async () => {
    const provs = await oc.providers().catch(() => [])
    const m = $selectedModel
    const prov = provs.find((p: any) => p.id === m?.providerID)
    limit = prov?.models?.[m?.modelID ?? '']?.limit?.context ?? 0
    if (!dir) dir = (await oc.path().catch(() => ({ directory: undefined })))?.directory ?? ''
  })

  // current session's own token tally — live SSE tallies land in sessionMetrics
  // and take precedence; the busy-keyed refresh above only seeds the value.
  $: usedTokens =
    (tab.live ? $sessionMetrics[tab.id]?.tokens : undefined) ?? fetchedTokens
  $: pct = limit ? Math.min(100, (usedTokens / limit) * 100) : 0
</script>

<div class="footer">
  {#if tab.busy}
    <span class="cylon" title="assistant working"><i></i></span>
  {/if}
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
    padding: 0px 18px 1px;
    max-width: 892px;
    margin: 0 auto;
    width: 100%;
    box-sizing: border-box;
    font-size: 11px;
    color: var(--fg-dim);
    user-select: none;
    min-height: 22px;
  }
  /* cylon scanner — back-and-forth sweep while the assistant works */
  .cylon {
    width: 34px;
    height: 8px;
    border-radius: 4px;
    background: var(--bg-hover, #21262d);
    overflow: hidden;
    position: relative;
    flex-shrink: 0;
  }
  .cylon i {
    position: absolute;
    top: 1px;
    left: 0;
    width: 10px;
    height: 6px;
    border-radius: 3px;
    background: var(--accent, #58a6ff);
    animation: cylon 1.1s ease-in-out infinite alternate;
  }
  @keyframes cylon {
    from { left: 0; }
    to { left: calc(100% - 10px); }
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
