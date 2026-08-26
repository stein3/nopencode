<script lang="ts">
  // which-key hint strip: shown while a ctrl+x leader chord is armed
  // (chordPending store, driven by hotkeys.ts). Renders nothing otherwise.
  import { chordPending } from '../lib/stores'
  import { CHORD_HINTS } from '../lib/hotkeys'

  const entries = Object.entries(CHORD_HINTS)
</script>

{#if $chordPending}
  <div class="whichkey" role="status" aria-label="ctrl+x chord pending">
    <span class="prefix">⌃x</span>
    <span class="entries">
      {#each entries as [key, label], i (key)}{#if i > 0}<span class="sep">·</span>{/if}<kbd>{key}</kbd><span class="lbl">{label}</span>{/each}
    </span>
  </div>
{/if}

<style>
  .whichkey {
    position: fixed;
    bottom: 64px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 90; /* below the palette overlay's 100 */
    display: flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 6px 12px;
    font-size: 11px;
    color: var(--fg-dim);
    box-shadow: 0 12px 34px rgba(0, 0, 0, 0.45);
    pointer-events: none;
    user-select: none;
  }
  .prefix {
    font-family: var(--mono);
    color: var(--accent);
    margin-right: 2px;
  }
  .entries {
    display: inline-flex;
    align-items: center;
  }
  kbd {
    font-family: var(--mono);
    color: var(--fg);
    background: var(--bg-hover);
    border-radius: 3px;
    padding: 0 4px;
  }
  .lbl {
    margin-left: 3px;
  }
  .sep {
    margin: 0 5px;
    opacity: 0.7;
  }
</style>
