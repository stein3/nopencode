<script lang="ts">
  import type { Tab } from '../lib/stores'
  import AgentPicker from './AgentPicker.svelte'
  import ComposerModelPicker from './ComposerModelPicker.svelte'

  export let tab: Tab
</script>

<div class="toolbar">
  <AgentPicker sid={tab.id} />
  <ComposerModelPicker sid={tab.id} />
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
  /* turn status ("Thinking…") is NOT here: it lives in the Footer's
     .status_indicator slot, so the composer strip stays pickers-only */
</style>
