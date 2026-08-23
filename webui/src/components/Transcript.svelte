<script lang="ts">
  import { marked } from 'marked'
  import DOMPurify from 'dompurify'
  import type { Tab } from '../lib/stores'

  export let tab: Tab

  let scroller: HTMLElement

  marked.setOptions({ gfm: true, breaks: true })

  const renderCache = new Map<string, string>()

  function html(part: any): string {
    if (part.type !== 'text') return ''
    const key = part.id ?? part.text
    const hit = renderCache.get(key)
    if (hit) return hit
    const raw = marked.parse(part.text ?? '') as string
    const safe = DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } })
    renderCache.set(key, safe)
    return safe
  }

  $: msgs = tab.messages.filter((m) => m.parts?.some((p) => p.type === 'text' || p.type === 'tool'))

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

  function toolSummary(p: any): string {
    const s = p.state?.status ?? p.state?.title ?? ''
    return `${p.tool ?? 'tool'}${s ? ` · ${s}` : ''}`
  }

  function timeStr(t?: number): string {
    return t ? new Date(t < 1e12 ? t * 1000 : t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
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
      </div>
      <div class="body">
        {#each partsOf(m) as p (p.id)}
          {#if p.type === 'text' && (p.text ?? '').trim()}
            {@html html(p)}
          {:else if p.type === 'tool'}
            <details class="tool">
              <summary>{toolSummary(p)}</summary>
              <pre>{JSON.stringify(p.state, null, 2)}</pre>
            </details>
          {/if}
        {/each}
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
</style>
