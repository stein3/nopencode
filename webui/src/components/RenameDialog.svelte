<script lang="ts">
  import { tick } from 'svelte'
  import { renameTarget, tabs, toast } from '../lib/stores'
  import { oc } from '../lib/api'

  let inputEl: HTMLInputElement
  let value = ''
  let busy = false

  // Seed via a plain store subscription, NOT a `$:` block — assigning `value`
  // inside a reactive statement makes the statement re-run whenever the bound
  // input invalidates `value`, instantly reverting user edits to the old title.
  renameTarget.subscribe((t) => {
    if (!t) return
    value = t.title
    busy = false
    focusInput()
  })

  async function focusInput() {
    await tick()
    inputEl?.focus()
    inputEl?.select()
    // retry — some browsers drop programmatic focus on just-inserted elements
    setTimeout(() => {
      if ($renameTarget && document.activeElement !== inputEl) {
        inputEl?.focus()
        inputEl?.select()
      }
    }, 60)
  }

  function close() {
    renameTarget.set(null)
  }

  async function submit() {
    const sid = $renameTarget?.sid
    const t = value.trim()
    if (!sid || !t || busy) return
    busy = true
    try {
      const s = await oc.renameSession(sid, t)
      tabs.patch(sid, { title: s.title ?? t })
      toast('renamed')
      close()
    } catch (e: any) {
      toast(`/rename failed: ${e.message ?? e}`)
    } finally {
      busy = false
    }
  }

  function key(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation()
      close()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      submit()
    }
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

{#if $renameTarget}
  <div class="overlay" role="presentation" on:mousedown={close}>
    <div class="panel" role="dialog" aria-label="Rename session" use:panelHandlers>
      <div class="title">Rename session</div>
      <!-- svelte-ignore a11y-autofocus -->
      <input
        id="rename-input"
        bind:this={inputEl}
        bind:value
        placeholder="Session title"
        spellcheck="false"
        autocomplete="off"
        maxlength="200"
        disabled={busy}
      />
      <div class="foot">
        <span class="keys">↵ rename · esc cancel</span>
        <button class="go" on:click={submit} disabled={busy || !value.trim()}>
          {busy ? 'renaming…' : 'rename'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    z-index: 110;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 14vh;
  }
  .panel {
    width: min(480px, 92vw);
    display: flex;
    flex-direction: column;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55);
    outline: none;
  }
  .title {
    padding: 10px 16px;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--fg-dim);
    border-bottom: 1px solid var(--border);
  }
  input {
    width: 100%;
    box-sizing: border-box;
    background: transparent;
    color: var(--fg);
    border: none;
    outline: none;
    padding: 13px 16px;
    font-size: 14px;
    font-family: var(--mono);
  }
  input:disabled {
    opacity: 0.6;
  }
  .foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    border-top: 1px solid var(--border);
    padding: 8px 12px;
  }
  .keys {
    font-size: 11px;
    color: var(--fg-dim);
    user-select: none;
  }
  .go {
    background: var(--accent);
    color: var(--bg-panel);
    border: none;
    border-radius: 6px;
    padding: 6px 14px;
    font-size: 12.5px;
    cursor: pointer;
  }
  .go:hover:not(:disabled) {
    filter: brightness(1.1);
  }
  .go:disabled {
    opacity: 0.45;
    cursor: default;
  }
</style>
