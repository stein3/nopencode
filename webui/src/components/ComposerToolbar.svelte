<script lang="ts">
  import { tabs, type Tab } from '../lib/stores'
  import AgentPicker from './AgentPicker.svelte'
  import ComposerModelPicker from './ComposerModelPicker.svelte'

  export let tab: Tab

  // Live thinking: busy + no assistant text yet (moved from Transcript)
  $: lastMsg = $tabs.find((t) => t.id === tab.id)?.messages?.at(-1)
  $: lastHasVisible =
    !!lastMsg?.parts?.some(
      (p) =>
        (p.type === 'text' && (p.text ?? '').trim()) ||
        p.type === 'tool' ||
        p.type === 'file',
    )
  $: liveThinking = tab.busy && (!lastMsg || lastMsg.role !== 'assistant' || !lastHasVisible)
</script>

<div class="toolbar">
  <AgentPicker sid={tab.id} />
  <ComposerModelPicker sid={tab.id} />
  {#if liveThinking}
    <div class="live-thinking">💭 Thinking<span class="dots"><i>.</i><i>.</i><i>.</i></span></div>
  {/if}
</div>

<style>
  .toolbar {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 4px;
    max-width: 892px;
    width: 100%;
    margin: 0 auto;
    padding: 0 4px;
    box-sizing: border-box;
  }
  .live-thinking {
    font-size: 12px;
    color: var(--fg-dim);
    white-space: nowrap;
    flex-shrink: 0;
  }
  .dots i {
    font-style: normal;
    animation: blink 1.4s infinite both;
  }
  .dots i:nth-child(2) { animation-delay: 0.2s; }
  .dots i:nth-child(3) { animation-delay: 0.4s; }
  @keyframes blink {
    0%, 80%, 100% { opacity: 0; }
    40% { opacity: 1; }
  }
</style>
