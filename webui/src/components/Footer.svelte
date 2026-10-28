<script lang="ts">
  import { onMount } from 'svelte'
  import { oc } from '../lib/api'
  import { RECENT_PAGE } from '../lib/sse'
  import {
    selectedModel,
    paletteOpen,
    sessionMetrics,
    metricsFromMessages,
    tabs,
    compactionStates,
  } from '../lib/stores'
  import type { Tab } from '../lib/stores'

  export let tab: Tab

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
      const [sess, msgs] = await Promise.all([
        oc.session(tab.id),
        oc.messages(tab.id, RECENT_PAGE),
      ])
      cost = sess?.cost ?? 0
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
  })

  // current session's own token tally — live SSE tallies land in sessionMetrics
  // and take precedence; the busy-keyed refresh above only seeds the value.
  $: usedTokens =
    (tab.live ? $sessionMetrics[tab.id]?.tokens : undefined) ?? fetchedTokens
  $: pct = limit ? Math.min(100, (usedTokens / limit) * 100) : 0

  // ---- live status indicator (moved here from the composer toolbar and the
  // transcript's inline compaction row): one animated slot, bottom of the pane,
  // so the transcript and the composer never carry turn-status chrome.
  $: cmpRunning = tab.compacting || $compactionStates[tab.id]?.state === 'running'
  // "Thinking…" only until the reply has something on screen — once text/tool/file
  // parts exist the transcript itself shows the turn progressing.
  $: lastMsg = $tabs.find((t) => t.id === tab.id)?.messages?.at(-1)
  $: lastHasVisible =
    !!lastMsg?.parts?.some(
      (p) =>
        (p.type === 'text' && (p.text ?? '').trim()) ||
        p.type === 'tool' ||
        p.type === 'file',
    )
  // must not claim thinking while a compaction summary is what's actually running
  $: liveThinking =
    tab.busy &&
    !cmpRunning &&
    (!lastMsg || lastMsg.role !== 'assistant' || !lastHasVisible)

  // The WHOLE label blinks, one character at a time, on the stagger the
  // three-dot ellipsis used to run (0.1s per char across the same 1.4s cycle).
  const LABELS = { thinking: 'thinking...', compacting: 'compacting...' }
  const CH_STEP = 0.1
</script>

<div class="footer">
  <!-- three zones: the session's numbers stay pinned left, turn status sits in
       the middle (scanner + label as ONE group, so the animation is centred no
       matter how wide the numbers get), ctrl+p pinned right. The side zones are
       equal flex shares, which is what keeps the middle truly centred. -->
  <div class="fleft">
    {#if usedTokens}
      <span class="seg" title="estimated context usage">
        {fmtK(usedTokens)}{limit ? ` (${pct.toFixed(0)}%)` : ''}
      </span>
    {/if}
    {#if cost > 0}
      <span class="seg" title="session spend">${cost.toFixed(3)}</span>
    {/if}
  </div>
  <div class="fcenter">
    {#if tab.busy}
      <span class="cylon" title="assistant working"><i></i></span>
    {/if}
    {#if cmpRunning}
      <span class="status_indicator compacting" role="status" aria-label="compacting" title="engine is writing the compaction summary">
        <span class="sglyph spin">⟳</span><span class="stext" aria-hidden="true">{#each [...LABELS.compacting] as ch, i}<i class="ch" style:animation-delay={`${(i * CH_STEP).toFixed(2)}s`}>{ch}</i>{/each}</span>
      </span>
    {:else if liveThinking}
      <span class="status_indicator thinking" role="status" aria-label="thinking" title="no reply text yet">
        <span class="stext" aria-hidden="true">{#each [...LABELS.thinking] as ch, i}<i class="ch" style:animation-delay={`${(i * CH_STEP).toFixed(2)}s`}>{ch}</i>{/each}</span>
      </span>
    {/if}
  </div>
  <div class="fright">
    <button class="cmd" title="Command palette" on:click={() => paletteOpen.set(true)}>
      ctrl+p commands
    </button>
  </div>
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
  /* three zones. Equal flex shares on the side zones keep .fcenter dead centred;
     min-width:0 everywhere so a long label or a wide number clips instead of
     pushing ctrl+p out of the pane. */
  .fleft {
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .fcenter {
    flex: 0 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .fright {
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 14px;
  }
  .seg {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* one shared slot for turn status: .thinking / .compacting are the variants */
  .status_indicator {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
    /* shrinkable on narrow viewports: the LABEL truncates (see .stext) rather
       than pushing the ctrl+p button out of the pane */
    flex: 0 1 auto;
    min-width: 0;
  }
  .status_indicator .stext {
    min-width: 0;
    overflow: hidden;
    display: inline-flex;
  }
  .status_indicator .sglyph {
    flex-shrink: 0;
    color: var(--accent, #58a6ff);
  }
  .status_indicator .sglyph.spin {
    display: inline-block;
    animation: sgspin 2.4s linear infinite;
  }
  @keyframes sgspin { to { transform: rotate(360deg); } }
  /* every character gets the ellipsis blink, delayed CH_STEP apart (set inline) */
  .status_indicator .ch {
    font-style: normal;
    display: inline-block;
    animation: sgblink 1.4s infinite both;
  }
  @keyframes sgblink {
    /* floor is .35, not 0: with 11-12 staggered characters a 0 floor left only
       about half of the word lit at any instant (illegible as status text) */
    0%, 80%, 100% { opacity: 0.35; }
    40% { opacity: 1; }
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
  /* Below ~380px the three contents want more than the pane has (numbers +
     scanner + label + button ≈ 330px into 320 of content box). Perfect centring
     and three full contents cannot both hold, so the narrow rule keeps the
     centred animation and gives way on the scanner (the blinking label already
     says "working") and the button's padding. NOTE: this block must stay AFTER
     .cmd / .cylon — same specificity, so an earlier copy simply loses. */
  @media (max-width: 380px) {
    .footer {
      gap: 6px;
      padding: 0px 10px 1px;
    }
    .fleft,
    .fright {
      gap: 8px;
    }
    .cmd {
      padding: 2px 4px;
    }
    .cylon {
      display: none;
    }
  }
  .cmd:hover {
    background: var(--bg-hover);
    color: var(--fg);
  }
</style>
