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

  // name → description for labeling `skill` tool calls; loaded once per mount
  let skillsIndex: Record<string, string> = {}

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
    oc.skills()
      .then((list) => {
        skillsIndex = Object.fromEntries((list ?? []).map((s: any) => [s.name, s.description ?? '']))
      })
      .catch(() => {})
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

  // ---- expanded tool detail ----------------------------------------------
  // Show the pertinent arguments instead of raw state JSON.
  const SHELL_RE = /bash|shell|cmd/

  function isShellTool(p: any): boolean {
    return SHELL_RE.test(String(p.tool ?? '').toLowerCase())
  }

  function shellCommand(p: any): string {
    return firstInput(p.state ?? {}, ['command', 'cmd', 'script'])
  }

  function toolOutputText(p: any): string {
    const st = p.state ?? {}
    const o = st.output ?? st.metadata?.output
    return typeof o === 'string' ? o : ''
  }

  function toolError(p: any): string {
    const e = p.state?.error
    if (!e) return ''
    if (typeof e === 'string') return e
    return e.message ?? JSON.stringify(e)
  }

  // ---- summary-line badges ------------------------------------------------
  function isTruncated(p: any): boolean {
    return p.state?.metadata?.truncated === true
  }

  function toolDuration(p: any): string {
    const t = p.state?.time
    if (!t || typeof t.start !== 'number' || typeof t.end !== 'number' || t.end < t.start) return ''
    const ms = t.end - t.start
    if (ms < 1000) return `${ms}ms`
    const s = ms / 1000
    if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`
    return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
  }

  // ---- diffs (edit/write/apply_patch) -------------------------------------
  type DiffLine = { k: 'add' | 'del' | 'hunk' | 'meta' | 'ctx'; s: string }

  function diffLines(text: string): DiffLine[] {
    return text
      .split('\n')
      .filter((l, i, a) => l.trim() !== '' || (i > 0 && i < a.length - 1))
      .map((s) => ({
        k: s.startsWith('+++') || s.startsWith('---')
          ? 'meta'
          : s.startsWith('@@') || s.startsWith('*** Update File') || s.startsWith('*** Add File') || s.startsWith('*** Delete File')
            ? 'meta'
            : s.startsWith('+')
              ? 'add'
              : s.startsWith('-')
                ? 'del'
                : 'ctx',
        s,
      }))
  }

  function patchTextOf(p: any): string {
    const st = p.state ?? {}
    const md = st.metadata ?? {}
    const patch =
      (typeof md.filediff?.patch === 'string' && md.filediff.patch) ||
      (typeof md.diff === 'string' && md.diff) ||
      ''
    if (patch) return patch
    // write has no before-image: synthesize an all-adds pseudo diff
    const c = st.input?.content ?? st.input?.newString
    return typeof c === 'string' && c.trim()
      ? c.replace(/\n$/, '').split('\n').map((l) => '+' + l).join('\n')
      : ''
  }

  // ---- question tool -------------------------------------------------------
  const QUESTION_RE = /^question/

  function isQuestionTool(p: any): boolean {
    return QUESTION_RE.test(String(p.tool ?? '').toLowerCase())
  }

  function questionRows(p: any): { q: any; picked: string[] }[] {
    const qs = p.state?.input?.questions
    if (!Array.isArray(qs)) return []
    const ans = p.state?.metadata?.answers
    return qs.map((q: any, i: number) => {
      const a = Array.isArray(ans) ? ans[i] : undefined
      const picked = Array.isArray(a) ? a : a != null ? [a] : []
      return { q, picked }
    })
  }

  type DetailBlock = { label: string; value: string; block?: boolean; kind?: 'text' | 'diff' }

  function addDetail(rows: DetailBlock[], label: string, v: unknown): void {
    if (v == null) return
    const s = typeof v === 'string' ? v : Array.isArray(v) || typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v)
    if (!s.trim()) return
    rows.push({ label, value: s.trim(), block: s.includes('\n') || s.length > 90 })
  }

  // One row per relevant argument; long/multi-line values render as blocks.
  function toolDetails(p: any): DetailBlock[] {
    const st = p.state ?? {}
    const inp = st.input ?? {}
    const tool = String(p.tool ?? '').toLowerCase()
    const rows: DetailBlock[] = []
    if (SHELL_RE.test(tool)) {
      addDetail(rows, 'command', inp.command ?? inp.cmd ?? inp.script)
      if (st.metadata?.exit !== undefined) addDetail(rows, 'exit', String(st.metadata.exit))
    } else if (/glob/.test(tool)) {
      addDetail(rows, 'pattern', inp.pattern)
      addDetail(rows, 'path', inp.path)
    } else if (/grep|find|search/.test(tool)) {
      addDetail(rows, 'pattern', inp.pattern ?? inp.query ?? inp.regex)
      addDetail(rows, 'include', inp.include ?? inp.file_pattern)
      addDetail(rows, 'path', inp.path)
    } else if (/read|view|cat|open/.test(tool)) {
      addDetail(rows, 'file', inp.filePath ?? inp.file_path ?? inp.path)
      const from = inp.offset ?? inp.start_line
      const to = inp.limit ?? inp.end_line
      if (from != null || to != null) addDetail(rows, 'lines', `${from ?? 0}–${to ?? ''}`)
    } else if (/list|ls|tree/.test(tool)) {
      addDetail(rows, 'path', inp.path ?? inp.dirPath)
    } else if (/edit|write|patch|save|multiedit|apply_patch/.test(tool)) {
      addDetail(rows, 'file', inp.filePath ?? inp.file_path ?? inp.path)
      const patch = patchTextOf(p)
      if (patch) rows.push({ label: 'diff', value: patch, kind: 'diff', block: true })
    } else if (/skill/.test(tool)) {
      const name = firstInput(st, ['name'])
      const desc = skillsIndex[name]
      addDetail(rows, 'description', desc || name)
    } else if (/fetch|web|http/.test(tool)) {
      addDetail(rows, 'url', inp.url ?? inp.link)
    } else if (/task|agent|subagent/.test(tool)) {
      addDetail(rows, 'description', inp.description)
      addDetail(rows, 'prompt', inp.prompt)
    } else if (/todo/.test(tool)) {
      const todos = Array.isArray(inp.todos) ? inp.todos : []
      const box = (s: string) => (s === 'completed' ? '[x]' : '[-]')
      if (todos.length)
        addDetail(rows, 'todos', todos.map((t: any) => `${box(t.status)} ${t.content ?? t.description ?? ''}`).join('\n'))
    }
    if (!rows.length) {
      // fallback: the call's arguments only (never the whole state blob)
      for (const [k, v] of Object.entries(inp)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') addDetail(rows, k.replace(/_/g, ' '), v)
      }
      if (!rows.length && typeof st.title === 'string' && st.title.trim()) addDetail(rows, 'title', st.title)
    }
    const err = toolError(p)
    if (err) addDetail(rows, 'error', err)
    return rows
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
    } else if (QUESTION_RE.test(tool)) {
      const qs = st.input?.questions
      if (Array.isArray(qs) && qs.length) {
        const q = qs[0]
        detail = (q.header ? q.header + ': ' : '') + (q.question ?? '')
      }
    } else if (/skill/.test(tool)) {
      const name = firstInput(st, ['name'])
      detail = skillsIndex[name] || name
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
            <div class="toolcard">
              <details class="tool">
                <summary>
                  <span class="sum-text">{toolSummary(p)}</span>
                  {#if isTruncated(p)}<span class="badge warn">truncated</span>{/if}
                  {#if toolDuration(p)}<span class="badge">{toolDuration(p)}</span>{/if}
                </summary>
                <div class="tool-body">
                  {#if isShellTool(p)}
                    <pre class="cmd">{shellCommand(p) || '…'}</pre>
                  {:else if isQuestionTool(p)}
                    {#each questionRows(p) as qr}
                      <div class="qa">
                        <div class="qq">{qr.q.header ? qr.q.header + ': ' : ''}{qr.q.question}</div>
                        {#each qr.q.options ?? [] as opt (opt.label)}
                          <div class="opt" class:picked={qr.picked.includes(opt.label)}>
                            <span class="mark">✓</span>
                            <span class="otext"><b>{opt.label}</b>{#if opt.description}<span class="odesc"> — {opt.description}</span>{/if}</span>
                          </div>
                        {/each}
                        {#if !qr.q.options?.length && qr.picked.length}
                          <div class="opt picked"><span class="mark">✓</span><span class="otext">{qr.picked.join(', ')}</span></div>
                        {/if}
                      </div>
                    {/each}
                  {:else}
                    {#each toolDetails(p) as d (d.label)}
                      {#if d.kind === 'diff'}
                        <div class="drow block"><span class="lbl">{d.label}</span><pre class="patch">{#each diffLines(d.value) as l, i (i)}<span class={l.k}>{l.s || ' '}</span>{/each}</pre></div>
                      {:else if d.block}
                        <div class="drow block"><span class="lbl">{d.label}</span><pre>{d.value}</pre></div>
                      {:else}
                        <div class="drow"><span class="lbl">{d.label}</span><span class="val">{d.value}</span></div>
                      {/if}
                    {/each}
                  {/if}
                </div>
              </details>
              {#if isShellTool(p)}
                <pre class="out">{toolOutputText(p) || (p.state?.status === 'running' ? '…' : '(no output)')}</pre>
              {/if}
            </div>
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
  .toolcard {
    margin: 6px 0;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-panel);
    font-size: 12px;
  }
  details.tool {
    margin: 0;
    font-size: inherit;
  }
  details.tool summary {
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    color: var(--fg-dim);
    user-select: none;
  }
  .sum-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .badge {
    flex: none;
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.04em;
    padding: 1px 6px;
    border-radius: 8px;
    background: var(--bg-hover);
    color: var(--fg-dim);
  }
  .badge.warn {
    color: var(--warn);
    box-shadow: inset 0 0 0 1px rgba(204, 167, 0, 0.35);
  }
  .tool-body {
    padding: 8px 10px;
    border-top: 1px solid var(--border);
    display: grid;
    gap: 6px;
  }
  .drow {
    display: flex;
    gap: 8px;
    align-items: baseline;
  }
  .drow.block {
    flex-direction: column;
    gap: 3px;
  }
  .drow .lbl {
    flex: none;
    min-width: 64px;
    color: var(--fg-dim);
    text-transform: uppercase;
    font-size: 10px;
    letter-spacing: 0.05em;
  }
  .drow .val {
    word-break: break-word;
    white-space: pre-wrap;
  }
  .tool-body pre {
    background: transparent;
    margin: 0;
    padding: 0;
    border: none;
    font-size: 11.5px;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: none;
  }
  .tool-body pre.patch {
    background: var(--bg-code);
    border-radius: 4px;
    padding: 6px 8px;
    font-size: 11px;
    white-space: pre;
    word-break: normal;
    overflow-x: auto;
  }
  .patch span {
    display: block;
  }
  .patch .add {
    color: var(--ok);
    background: #2ea04326;
  }
  .patch .del {
    color: var(--err);
    background: #f8514926;
  }
  .patch .hunk,
  .patch .meta {
    color: var(--user-accent);
    opacity: 0.85;
  }
  .qa + .qa {
    border-top: 1px dashed var(--border);
    padding-top: 8px;
  }
  .qq {
    font-weight: 600;
    margin-bottom: 4px;
  }
  .opt {
    display: flex;
    gap: 6px;
    align-items: baseline;
    padding: 1.5px 0;
    color: var(--fg-dim);
  }
  .opt.picked {
    color: var(--fg);
  }
  .opt .mark {
    flex: none;
    width: 12px;
    color: var(--ok);
    font-weight: 700;
  }
  .opt:not(.picked) .mark {
    visibility: hidden;
  }
  .odesc {
    color: var(--fg-dim);
    font-weight: 400;
  }
  .toolcard .out {
    margin: 0;
    padding: 10px;
    border-top: 1px dashed var(--border);
    background: transparent;
    font-size: 11.5px;
    line-height: 1.45;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--fg-dim);
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
