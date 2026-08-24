<script lang="ts">
  import { onMount } from 'svelte'
  import { tabs, showThinking, showTimestamps, type Tab } from '../lib/stores'
  import { oc, type OcMessage } from '../lib/api'
  import { refetchNow } from '../lib/sse'
  import { md } from '../lib/markdown'

  export let tab: Tab

  let scroller: HTMLElement
  let feed: HTMLElement

  const renderCache = new Map<string, string>()

  function html(part: any): string {
    if (part.type !== 'text') return ''
    // length in key so streaming appends invalidate the cached render
    const key = `${part.id ?? 'x'}:${(part.text ?? '').length}`
    const hit = renderCache.get(key)
    if (hit) return hit
    const safe = md(part.text ?? '')
    if (renderCache.size > 400) renderCache.clear()
    renderCache.set(key, safe)
    return safe
  }

  // The engine only marks a revert point; messages are pruned on the next
  // prompt. Mirror the official clients and cut the view at the boundary now.
  function applyRevert(msgs: OcMessage[], r: Tab['revert']): OcMessage[] {
    if (!r?.messageID) return msgs
    const i = msgs.findIndex((m) => m.id === r.messageID)
    if (i < 0) return msgs
    if (!r.partID) return msgs.slice(0, i)
    const m = msgs[i]
    const parts = m.parts ?? []
    const pi = parts.findIndex((p) => p.id === r.partID)
    return [...msgs.slice(0, i), { ...m, parts: pi < 0 ? parts : parts.slice(0, pi) }]
  }

  $: msgs = applyRevert(tab.messages, tab.revert).filter((m) =>
    m.parts?.some((p) => p.type === 'text' || p.type === 'tool' || p.type === 'reasoning'),
  )
  $: lastMsg = msgs.at(-1)
  $: lastHasVisible =
    !!lastMsg?.parts?.some(
      (p) => (p.type === 'text' && (p.text ?? '').trim()) || p.type === 'tool',
    )
  $: liveThinking = tab.busy && (!lastMsg || lastMsg.role !== 'assistant' || !lastHasVisible)
  $: lastThinkingOpen = !!lastMsg?.parts?.some(
    (p) => p.type === 'reasoning' && !(p.text ?? '').trim(),
  )

  // ---- stick-to-bottom ----------------------------------------------------
  // Follow new content (streaming text, thinking blocks, tool cards, images)
  // while the reader is at the bottom; stop as soon as they scroll up to read
  // back, resume when they return. A ResizeObserver on the feed catches every
  // height change — delta appends don't change part counts, so a message-level
  // trigger alone would miss most of the stream.
  let stuck = true

  function onScroll() {
    if (!scroller) return
    stuck = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120
  }

  function follow() {
    if (!stuck || !scroller) return
    requestAnimationFrame(() => {
      if (stuck && scroller) scroller.scrollTop = scroller.scrollHeight
    })
  }

  onMount(() => {
    const ro = new ResizeObserver(follow)
    if (feed) ro.observe(feed)
    follow()
    return () => ro.disconnect()
  })

  function partsOf(m: any): any[] {
    return m?.parts ?? []
  }

  // reasoning parts stream in before the answer; show the latest as "Thinking"
  function thinkingText(parts: any[]): string {
    const r = parts.filter((p) => p.type === 'reasoning' && (p.text ?? '').trim())
    return r.length ? r[r.length - 1].text : ''
  }

  function firstInput(st: any, keys: string[]): string {
    const inp = st?.input ?? {}
    for (const k of keys) {
      const v = inp[k]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
    return ''
  }

  function clip(s: string, n = 120): string {
    const one = s.replace(/\s+/g, ' ').trim()
    return one.length > n ? one.slice(0, n - 1) + '…' : one
  }

  // One-line summary per tool: read → file, glob → pattern, bash → command…
  // Falls back to the engine's own title, then any string argument.
  function toolSummary(p: any): string {
    const st = p.state ?? {}
    const status = typeof st.status === 'string' ? st.status : ''
    const glyph = status === 'error' ? '✗ ' : status === 'running' || status === 'pending' ? '⏳ ' : ''
    const tool = String(p.tool ?? '').toLowerCase()
    let detail = ''
    if (/bash|shell|cmd/.test(tool)) {
      detail = firstInput(st, ['command', 'cmd', 'script'])
    } else if (/glob/.test(tool)) {
      const path = firstInput(st, ['path'])
      detail = firstInput(st, ['pattern']) + (path ? ` in ${path}` : '')
    } else if (/grep|find|search/.test(tool)) {
      const inc = firstInput(st, ['include', 'file_pattern'])
      const path = firstInput(st, ['path'])
      detail =
        firstInput(st, ['pattern', 'query', 'regex']) +
        (inc ? ` (${inc})` : '') +
        (path ? ` in ${path}` : '')
    } else if (/read|view|cat|open|list|ls|tree/.test(tool)) {
      detail = firstInput(st, ['filePath', 'file_path', 'path'])
    } else if (/edit|write|patch|save|multiedit/.test(tool)) {
      detail = firstInput(st, ['filePath', 'file_path', 'path'])
    } else if (/fetch|web|http/.test(tool)) {
      detail = firstInput(st, ['url', 'link'])
    } else if (/task|agent|subagent/.test(tool)) {
      detail = firstInput(st, ['description', 'prompt'])
    } else if (/todo/.test(tool)) {
      const n = Array.isArray(st.input?.todos) ? st.input.todos.length : 0
      if (n) detail = `${n} todo${n === 1 ? '' : 's'}`
    }
    if (!detail) detail = typeof st.title === 'string' && st.title.trim() ? st.title.trim() : ''
    if (!detail) {
      const inp = st?.input ?? {}
      const v = Object.values(inp).find((x) => typeof x === 'string' && x.trim())
      if (v) detail = v as string
    }
    return glyph + [p.tool ?? 'tool', clip(detail)].filter(Boolean).join(' · ')
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
      // response is the updated session info, incl. the revert point — apply
      // it immediately so the transcript updates without waiting for events
      const s = await oc.revertTo(tab.id, mid)
      tabs.patch(tab.id, { revert: s.revert ?? null })
      refetchNow(tab.id)
    } catch (e: any) {
      alert(`revert failed: ${e.message ?? e}`)
    }
  }
</script>

<div class="transcript" bind:this={scroller} on:scroll={onScroll}>
  <div class="feed" bind:this={feed}>
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
        {#if $showTimestamps}
          <span class="time">{timeStr(m.time?.created)}</span>
        {/if}
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
            <details class="thinking" open={$showThinking || p.id === lastThinkingOpen || undefined}>
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
        {#if liveThinking && m === lastMsg}
          <div class="live-thinking">💭 Thinking<span class="dots"><i>.</i><i>.</i><i>.</i></span></div>
        {/if}
      </div>
    </div>
  {/each}
  </div>
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
    margin: 0 auto;
    padding: 5px 16px;
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
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
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
