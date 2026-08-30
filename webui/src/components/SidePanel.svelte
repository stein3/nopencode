<script lang="ts">
  import { sidePanel } from '../lib/sidePanel'

  export let title: string = ''
  export let onClose: () => void = () => {}
  export let side: 'left' | 'right' = 'right'
</script>

<aside class="panel" use:sidePanel={{ side, getOpen: () => true, setOpen: () => onClose() }}>
  <div class="head">
    <span class="ttl">{title}</span>
    <slot name="actions" />
    <button class="close" title="Close" on:click={onClose}>✕</button>
  </div>
  <slot />
</aside>

<style>
  .panel {
    width: 240px;
    flex-shrink: 0;
    background: var(--bg-panel);
    border-left: 1px solid var(--border);
    padding: 12px;
    overflow-y: auto;
    height: 100vh;
    box-sizing: border-box;
  }
  @supports (height: 100dvh) {
    .panel {
      height: var(--vvh, 100dvh);
    }
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }
  .ttl {
    font-weight: 600;
    font-size: 13px;
  }
  .close {
    margin-left: auto;
    font-size: 13px;
    padding: 3px 8px;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 5px;
    color: var(--fg-dim);
    cursor: pointer;
    line-height: 1;
  }
  .close:hover {
    color: var(--accent);
    border-color: var(--accent);
  }
</style>
