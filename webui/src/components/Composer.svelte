<script lang="ts">
  import { oc } from '../lib/api'
  import { tabs, selectedModel, paletteOpen } from '../lib/stores'
  import type { Tab } from '../lib/stores'

  export let tab: Tab
  export let onSent: (sessionId: string) => void

  let text = ''
  let ta: HTMLTextAreaElement
  let sending = false
  let sendError = ''

  export function focus() {
    ta?.focus()
  }

  async function send() {
    const body = text.trim()
    if (!body || tab.busy || sending) return
    if (body.startsWith('/')) {
      // slash command, not a chat message
      const name = body.slice(1).split(/\s+/)[0]
      text = ''
      autosize()
      tabs.patch(tab.id, { busy: true })
      try {
        await oc.runCommand(tab.id, name)
        onSent(tab.id)
      } catch (e: any) {
        tabs.patch(tab.id, { busy: false })
        sendError = e.message ?? String(e)
      }
      return
    }
    sending = true
    sendError = ''
    tabs.patch(tab.id, { busy: true }) // optimistic spinner immediately
    try {
      await oc.prompt(tab.id, body, $selectedModel ?? undefined)
      text = ''
      autosize()
      onSent(tab.id)
    } catch (e: any) {
      tabs.patch(tab.id, { busy: false })
      sendError = e.message ?? String(e)
    } finally {
      sending = false
    }
  }

  function key(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    } else if (e.key === '/' && text === '') {
      // leading slash opens the command palette like the TUI
      e.preventDefault()
      paletteOpen.set(true)
    }
  }

  async function abort() {
    try {
      await oc.abort(tab.id)
      tab.busy = false
    } catch {
      /* ignore */
    }
  }

  function autosize() {
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
  }
</script>

<div class="composer">
  {#if sendError}
    <div class="error">send failed: {sendError}</div>
  {:else if tab.error}
    <div class="error">{tab.error}</div>
  {/if}
  <div class="box">
    <textarea
      bind:this={ta}
      bind:value={text}
      rows="1"
      placeholder="Message…  (Enter to send, Shift+Enter newline, / to focus)"
      on:keydown={key}
      on:input={autosize}
    ></textarea>
    {#if tab.busy}
      <button class="stop" title="Abort" on:click={abort}>■</button>
    {:else}
      <button class="go" disabled={!text.trim() || sending} title="Send" on:click={send}>➤</button>
    {/if}
  </div>
</div>

<style>
  .composer {
    padding: 10px 16px 14px;
    max-width: 892px;
    margin: 0 auto;
    width: 100%;
    box-sizing: border-box;
  }
  .error {
    color: var(--err);
    font-size: 12px;
    margin-bottom: 6px;
  }
  .box {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px;
  }
  .box:focus-within {
    border-color: var(--accent);
  }
  textarea {
    flex: 1;
    resize: none;
    background: transparent;
    color: var(--fg);
    border: none;
    outline: none;
    font: inherit;
    font-size: 13.5px;
    line-height: 1.45;
    min-height: 22px;
    max-height: 200px;
  }
  button {
    width: 30px;
    height: 30px;
    border-radius: 6px;
    border: none;
    cursor: pointer;
    font-size: 13px;
    flex-shrink: 0;
  }
  .go {
    background: var(--accent);
    color: #fff;
  }
  .go:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .stop {
    background: var(--err);
    color: #fff;
  }
</style>
