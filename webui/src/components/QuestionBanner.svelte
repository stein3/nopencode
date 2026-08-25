<script lang="ts">
  // "Questions pending" cue for one session pane: a slim strip above the
  // composer shown only while the engine holds a question tool open for THIS
  // session. Clicking jumps to the question card by planting Tab.jumpTo —
  // Transcript owns the actual scroll (same mechanism as search-anchor
  // jumps), so this component only sets the anchor and stands back.
  import { pendingQuestions, tabs } from '../lib/stores'
  import { backfill, JUMP_CAP } from '../lib/sse'

  export let sessionId: string

  // Same attribution rule as the sidebar ask-dot / tab dot: sessionID must
  // match (a request without one can't be pinned on a pane).
  $: mine = $pendingQuestions.filter((q) => q.sessionID === sessionId)
  // Count QUESTIONS, not requests — one request can carry several. A malformed
  // request with an empty list still counts once, so the banner never says 0.
  $: count = mine.reduce((n, q) => n + (q.questions?.length || 0), 0) || mine.length
  $: first = mine[0]
  $: header = first?.questions?.[0]?.header || first?.questions?.[0]?.question || ''

  async function jump() {
    const mid = first?.tool?.messageID
    if (!mid || !sessionId) return
    const snap = tabs.snapshot(sessionId)
    if (!snap) return
    // Row mounted (or inside the loaded window, so it renders with the pane):
    // plant the anchor — Transcript parks on it and follow() stands down
    // until it does. Dormant panes render rows synchronously from memory on
    // activation, so this also covers the just-reactivated case.
    if (snap.messages.some((m) => m.id === mid) || document.getElementById(`m-${mid}`)) {
      tabs.patch(sessionId, { jumpTo: mid })
      return
    }
    // Anchor deeper than the loaded window: pull a capped window like the
    // search-hit jumps do; stay silent if it still isn't there (graceful
    // no-op beats leaving a dangling jumpTo that would pin follow() forever).
    if (snap.live) {
      await backfill(sessionId, JUMP_CAP)
      if (tabs.snapshot(sessionId)?.messages.some((m) => m.id === mid))
        tabs.patch(sessionId, { jumpTo: mid })
    }
  }
</script>

{#if mine.length}
  <div class="qbwrap" aria-live="polite">
    <button class="qbanner" on:click={jump} title="Jump to the question card">
      <span class="qdot" aria-hidden="true"></span>
      <span class="qtext"><b>{count}</b> {count === 1 ? 'question' : 'questions'} awaiting your answer</span>
      {#if header}
        <span class="qsep" aria-hidden="true">·</span>
        <span class="qhead">{header}</span>
      {/if}
      <span class="qjump" aria-hidden="true">↑</span>
    </button>
  </div>
{/if}

<style>
  /* Same column recipe as .perm-inline / transcript rows so the strip's
     edges line up with the composer box above/below it */
  .qbwrap {
    flex: none;
    width: 100%;
    max-width: 860px;
    margin: 0 auto;
    padding: 0 16px 8px;
  }
  .qbanner {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-width: 0;
    background: rgba(227, 210, 111, 0.07);
    border: 1px solid rgba(227, 210, 111, 0.35);
    border-left: 3px solid #e3d26f;
    border-radius: 6px;
    padding: 7px 10px;
    font-size: 12.5px;
    line-height: 1.4;
    font-family: inherit;
    color: var(--fg);
    cursor: pointer;
    text-align: left;
    animation: qbin 0.16s ease-out; /* one-shot entrance, then static */
  }
  .qbanner:hover {
    background: rgba(227, 210, 111, 0.13);
  }
  .qbanner:focus-visible {
    outline: 1px solid #e3d26f;
    outline-offset: 1px;
  }
  .qdot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #e3d26f;
    /* same transient rhythm as the card's .qwait text — lives only while a
       question pends, unmounts with the banner */
    animation: qbpulse 1.6s ease-in-out infinite;
    will-change: opacity;
  }
  @keyframes qbpulse {
    50% {
      opacity: 0.45;
    }
  }
  @keyframes qbin {
    from {
      transform: translateY(6px);
      opacity: 0;
    }
  }
  .qtext {
    flex: none;
    white-space: nowrap;
  }
  .qtext b {
    font-weight: 600;
    color: #e3d26f;
  }
  .qsep {
    flex: none;
    opacity: 0.5;
  }
  .qhead {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fg-dim);
  }
  .qjump {
    flex: none;
    margin-left: auto;
    color: var(--fg-dim);
    font-size: 13px;
  }
</style>
