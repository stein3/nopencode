<script lang="ts">
  import { lightbox } from '../lib/stores'

  function close() {
    lightbox.set(null)
  }

  function key(e: KeyboardEvent) {
    if (e.key === 'Escape') close()
  }

  // keep mouse/keyboard handling off the non-interactive role="dialog" node
  function panelHandlers(node: HTMLElement) {
    const stopMousedown = (e: Event) => e.stopPropagation()
    node.addEventListener('mousedown', stopMousedown)
    node.addEventListener('keydown', key)
    return {
      destroy() {
        node.removeEventListener('mousedown', stopMousedown)
        node.removeEventListener('keydown', key)
      },
    }
  }
</script>

<svelte:window on:keydown={key} />

{#if $lightbox}
  <div class="overlay" role="presentation" on:mousedown={close}>
    <div class="frame" role="dialog" aria-label="Image preview" tabindex="-1" use:panelHandlers>
      <img src={$lightbox.src} alt={$lightbox.caption ?? 'image'} />
      {#if $lightbox.caption}
        <div class="cap">{$lightbox.caption}</div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.78);
    z-index: 130;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: zoom-out;
  }
  .frame {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    max-width: 94vw;
    cursor: default;
    outline: none;
  }
  .frame img {
    max-width: 94vw;
    max-height: 86vh;
    object-fit: contain;
    border-radius: 6px;
    border: 1px solid var(--border);
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55);
  }
  .cap {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--fg-dim);
    max-width: 94vw;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    user-select: none;
  }
</style>
