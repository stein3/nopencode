<script lang="ts">
  import { marked } from 'marked'
  import DOMPurify from 'dompurify'
  import { tabs, type Tab } from '../lib/stores'
  import { oc } from '../lib/api'
  import { refetchNow } from '../lib/sse'

  export let tab: Tab

  let scroller: HTMLElement

  marked.setOptions({ gfm: true, breaks: true })

  const renderCache = new Map<string, string>()

  function html(part: any): string {
    if (part.type !== 'text') return ''
    // length in key so streaming appends invalidate the cached render
    const key = `${part.id ?? 'x'}:${(part.text ?? '').length}`
    const hit = renderCache.get(key)
    if (hit) return hit
    const raw = marked.parse(part.text ?? '') as string
    const safe = DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } })
    if (renderCache.size > 400) renderCache.clear()
    renderCache.set(key, safe)
    return safe
  }

  $: msgs = tab.messages.filter((m) =>
    m.parts?.some((p) => p.type === 'text' || p.type === 'tool' || p.type === 'reasoning'),
  )
  $: lastMsg = msgs.at(-1)
  $: lastHasVisible =
    !!lastMsg?.parts?.some(
      (p) => (p.type === 'text' && (p.text ?? '').trim()) || p.type === 'tool',
    )
  $: showThinking = tab.busy && (!lastMsg || lastMsg.role !== 'assistant' || !lastHasVisible)
  $: lastThinkingOpen = !!lastMsg?.parts?.some(
    (p) => p.type === 'reasoning' && !(p.text ?? '').trim(),
  )

  $: lastLen = JSON.stringify(msgs.at(-1)?.parts?.length) + '-' + msgs.length
  let prevLen = ''
  $: if (lastLen !== prevLen && scroller) {
    prevLen = lastLen
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160
    if (nearBottom) requestAnimationFrame(() => scroller.scrollTo({ top: scroller.scrollHeight }))
  }

  function partsOf(m: any): any[] {
    return m?.parts ?? []
  }

  // reasoning parts stream in before the answer; show the latest as "Thinking"
  function thinkingText(parts: any[]): string {
    const r = parts.filter((p) => p.type === 'reasoning' && (p.text ?? '').trim())
    return r.length ? r[r.length - 1].text : ''
  }

  function toolSummary(p: any): string {
    const s = p.state?.status ?? p.state?.title ?? ''
    return `${p.tool ?? 'tool'}${s ? ` · ${s}` : ''}`
  }

  function timeStr(t?: number): string {
    return t ? new Date(t < 1e12 ? t * 1000 : t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
  }

  async function delMessage(mid: string) {
    if (!confirm('Delete this message?')) return
    try {
      await oc.deleteMessage(tab.id, mid)
      refetchNow(tab.id)
    } catch (e: any) {
      alert(`delete failed: ${e.message ?? e}`)
    }
  }

  async function revertTo(mid: string) {
    try {
      await oc.revertTo(tab.id, mid)
      refetchNow(tab.id)
    } catch (e: any) {
      alert(`revert failed: ${e.message ?? e}`)
    }
  }
</script>

<div class="transcript" bind:this={scroller}>
  {#if !tab.messages.length}
    <div class="empty">
      <div class="logo">opencode</div>
      {#if tab.live}
        Type below to start the conversation.
      {:else}
        No message data for this session.
      {/if}
    </div>
  {/if}
  {#each msgs as m (m.id)}
    <div class="msg" class:user={m.role === 'user'} id={`m-${m.id}`}>
      <div class="head" title={m.role}>
        <span class="role">{m.role === 'user' ? 'you' : m.agent || 'opencode'}</span>
        <span class="time">{timeStr(m.time?.created)}</span>
        {#if m.role === 'user'}
          <span class="acts">
            <button class="act" title="Revert session to before this message" on:click={() => revertTo(m.id)}>↩</button>
            <button class="act" title="Delete message" on:click={() => delMessage(m.id)}>🗑</button>
          </span>
        {/if}
      </div>
      <div class="body">
        {#each partsOf(m) as p (p.id)}
          {#if p.type === 'text' && (p.text ?? '').trim()}
            {@html html(p)}
          {:else if p.type === 'reasoning' && (p.text ?? '').trim()}
            <details class="thinking" open={p.id === lastThinkingOpen || undefined}>
              <summary>💭 Thinking</summary>
              <div class="think-body">{p.text}</div>
            </details>
          {:else if p.type === 'tool'}
            <details class="tool">
              <summary>{toolSummary(p)}</summary>
              <pre>{JSON.stringify(p.state, null, 2)}</pre>
            </details>
          {/if}
        {/each}
        {#if showThinking && m === lastMsg}
          <div class="live-thinking">💭 Thinking<span class="dots"><i>.</i><i>.</i><i>.</i></span></div>
        {/if}
      </div>
    </div>
  {/each}
</div>

<style>
  .transcript {
    flex: 1;
    overflow-y: auto;
    padding: 18px 0 30px;
  }
  .empty {
    text-align: center;
    color: var(--fg-dim);
    margin-top: 18vh;
  }
  .logo {
    font-size: 22px;
    letter-spacing: 0.3em;
    margin-bottom: 8px;
    color: var(--accent);
  }
  .msg {
    max-width: 860px;
    margin: 0 auto 18px;
    padding: 10px 16px;
    user-select: text;
    cursor: text;
  }
  .msg.user {
    background: var(--bg-user);
    border-left: 2px solid var(--user-accent);
    border-radius: 6px;
  }
  .head {
    display: flex;
    gap: 8px;
    align-items: baseline;
    font-size: 11px;
    color: var(--fg-dim);
    margin-bottom: 4px;
    user-select: none;
  }
  .role {
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  :global(.msg:not(.user)) .role {
    color: var(--accent);
  }
  .time {
    opacity: 0.7;
  }
  .acts {
    margin-left: auto;
    display: none;
    gap: 4px;
  }
  .msg:hover .acts {
    display: inline-flex;
  }
  .act {
    background: transparent;
    border: none;
    color: var(--fg-dim);
    cursor: pointer;
    font-size: 11px;
    padding: 0 4px;
    border-radius: 4px;
  }
  .act:hover {
    background: var(--bg-hover);
    color: var(--fg);
  }
  /* rendered markdown */
  .body {
    line-height: 1.55;
    font-size: 13.5px;
    word-wrap: break-word;
  }
  .body :global(pre) {
    background: var(--bg-code);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px 12px;
    overflow-x: auto;
    font-size: 12.5px;
    line-height: 1.45;
  }
  .body :global(code) {
    font-family: var(--mono);
    background: var(--bg-code);
    border-radius: 4px;
    padding: 1px 4px;
    font-size: 0.92em;
  }
  .body :global(pre code) {
    background: transparent;
    padding: 0;
  }
  .body :global(a) {
    color: var(--accent);
  }
  details.tool {
    margin: 6px 0;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-panel);
    font-size: 12px;
  }
  details.tool summary {
    cursor: pointer;
    padding: 5px 10px;
    color: var(--fg-dim);
    user-select: none;
  }
  details.tool pre {
    max-height: 300px;
    overflow: auto;
    margin: 0;
    padding: 10px;
    border-top: 1px solid var(--border);
    font-size: 11.5px;
  }
  details.thinking {
    margin: 6px 0;
    border: 1px dashed var(--border);
    border-radius: 6px;
    background: var(--bg-panel);
    font-size: 12px;
  }
  details.thinking summary {
    cursor: pointer;
    padding: 5px 10px;
    color: var(--fg-dim);
    user-select: none;
  }
  .think-body {
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--fg-dim);
    padding: 8px 12px;
    border-top: 1px dashed var(--border);
    max-height: 260px;
    overflow-y: auto;
    line-height: 1.5;
  }
  .live-thinking {
    color: var(--fg-dim);
    font-size: 12.5px;
    padding: 4px 2px;
    font-style: italic;
  }
  .dots i {
    animation: blink 1.2s infinite;
    font-style: normal;
  }
  .dots i:nth-child(2) {
    animation-delay: 0.2s;
  }
  .dots i:nth-child(3) {
    animation-delay: 0.4s;
  }
  @keyframes blink {
    0%, 60% { opacity: 0.15; }
    30% { opacity: 1; }
  }
</style>
