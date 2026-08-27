<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { oc } from '../lib/api'
  import type { OcFilePart } from '../lib/api'
  import { tabs, selectedModel, sessionModel, sessionAgent, cmdVersion } from '../lib/stores'
  import type { Tab } from '../lib/stores'
  import { registry, type Cmd } from '../lib/commands'
  import { RECENT_PAGE, normalizeMessages } from '../lib/sse'
  import { cancelRetry } from '../lib/retries'
  import {
    MAX_FILE_BYTES,
    MAX_TOTAL_BYTES,
    formatSize,
    extLabel,
    midTrunc,
    isImageMime,
    readAttachment,
    type Attachment,
  } from '../lib/attachments'
  import AgentPicker from './AgentPicker.svelte'

  export let tab: Tab
  export let onSent: (sessionId: string) => void
  // creates the engine session on first use (pending tabs)
  export let realize: () => Promise<string> = async () => tab.id
  // a file drag is hovering this pane (App drives it) — dashed accent affordance
  export let dropActive = false

  let text = ''
  let ta: HTMLTextAreaElement
  let sending = false
  let sendError = ''
  let sel = 0

  // ---- attachments -------------------------------------------------------
  // Staged files for the NEXT message. Images keep a thumbnail data URL;
  // everything else shows an extension badge. Sent as file parts after the
  // text part; the tray clears once the dispatch starts.
  let atts: Attachment[] = []
  let attErrors: string[] = []
  let fileInput: HTMLInputElement

  export async function attachFiles(list: FileList | File[]): Promise<void> {
    const arr = Array.from(list ?? [])
    if (!arr.length) return
    attErrors = []
    const errs: string[] = []
    const ok: Attachment[] = []
    let total = atts.reduce((s, a) => s + a.size, 0)
    for (const f of arr) {
      if (f.size > MAX_FILE_BYTES) {
        errs.push(`${f.name || 'file'} is larger than ${formatSize(MAX_FILE_BYTES)}`)
        continue
      }
      if (total + f.size > MAX_TOTAL_BYTES) {
        errs.push(
          `adding ${f.name || 'file'} would exceed the ${formatSize(MAX_TOTAL_BYTES)} per-message limit`,
        )
        continue
      }
      try {
        const a = await readAttachment(f)
        ok.push(a)
        total += a.size
      } catch {
        errs.push(`could not read ${f.name || 'file'}`)
      }
    }
    if (ok.length) atts = [...atts, ...ok]
    attErrors = errs
  }

  function removeAtt(id: string) {
    atts = atts.filter((a) => a.id !== id)
    if (!atts.length) attErrors = []
  }

  function pickFiles() {
    fileInput?.click()
  }

  function onPick() {
    if (fileInput?.files?.length) void attachFiles(fileInput.files)
    fileInput.value = '' // re-picking the same file must fire change again
  }

  // Paste: image/file content on the clipboard becomes an attachment; plain
  // text keeps the native behavior untouched.
  function paste(e: ClipboardEvent) {
    const items = e.clipboardData?.items
    if (!items) return
    const files: File[] = []
    for (const it of items) {
      if (it.kind === 'file') {
        const f = it.getAsFile()
        if (f) files.push(f)
      }
    }
    if (!files.length) return
    e.preventDefault()
    void attachFiles(files)
  }

  function toFilePart(a: Attachment): OcFilePart {
    return { type: 'file', mime: a.mime, url: a.dataUrl, filename: a.filename }
  }


  registry.load()

  // Fork-refill: a fork carries the forked-from message's text in Tab.prefill;
  // consume it once when the pane mounts (the tab is brand-new, so the box is
  // always empty here).
  onMount(() => {
    if (tab.prefill) {
      const t = tab.prefill
      tabs.patch(tab.id, { prefill: undefined })
      prefill(t)
    }
  })

  export function focus() {
    ta?.focus()
  }

  // Focus insurance for soft keyboards that overlay the layout instead of
  // resizing it: once the box gains focus, nudge it into whatever visual
  // area remains. Best-effort — a no-op when there is nothing to scroll.
  function onTaFocus() {
    try {
      ta?.scrollIntoView({ block: 'nearest' })
    } catch {
      /* engines without ScrollIntoViewOptions */
    }
  }

  // Revert-refill: drop a reverted message's text back into the box so it can
  // be edited and resent. Never clobbers a draft the user already started.
  export function prefill(t: string) {
    if (!t || text.trim()) return
    text = t
    autosize()
    focus()
  }

  // ---- inline slash menu -------------------------------------------------
  // active while the box starts with "/name" (trailing space/args allowed
  // so the menu stays open after the user picks a command and types args)
  $: slashQuery = /^\/([a-z0-9_-]*\S*)/.exec(text)
  $: menuOpen = !!slashQuery
  $: filtered = menuOpen ? filterCmds(slashQuery![1], $cmdVersion) : []
  $: if (menuOpen && sel >= filtered.length) sel = Math.max(0, filtered.length - 1)

  function filterCmds(q: string, _version: number): Cmd[] {
    const ql = q.toLowerCase()
    const all = registry.all()
    const byName = all.filter((c) => c.name.startsWith(ql))
    return byName.length ? byName : all.filter((c) => c.description.toLowerCase().includes(ql))
  }

  async function pickFromMenu(c: Cmd): Promise<void> {
    if (c.source === 'builtin') {
      text = ''
      autosize()
      try {
        await c.run(ctx(), '')
      } catch (e: any) {
        toastErr(e)
      }
    } else {
      // engine command/skill: stage it in the box so arguments can be added
      text = '/' + c.name + ' '
      autosize()
      await tick()
      focusAtEnd()
    }
    ta?.focus()
  }

  function ctx(override?: string) {
    const sid = override ?? (tab.pending ? null : tab.id)
    return {
      sessionId: () => sid,
      newChat: () => window.dispatchEvent(new CustomEvent('oc:new-chat')),
      focusComposer: () => ta?.focus(),
      focusSidebar: () => document.dispatchEvent(new CustomEvent('oc:focus-sidebar')),
    }
  }

  function toastErr(e: any) {
    sendError = e?.message ?? String(e)
  }

  function focusAtEnd() {
    if (!ta) return
    const n = ta.value.length
    ta.setSelectionRange(n, n)
  }

  // ---- send ---------------------------------------------------------------
  // NOTE: tab.busy does NOT block — the engine queues messages sent during an
  // in-flight turn (verified: the busy POST waits, then runs in order), so the
  // composer lets you line up the next message instead of dead-ending on the
  // stop button (which also used to trap sessions waiting on a question).
  //
  // `sending` only covers prep + dispatch. oc.prompt is fire-and-return
  // (engine prompt_async → 204); the turn itself streams in over SSE, so
  // nothing here waits on it. The flight is still detached and its errors
  // handled by failedSend() in case the dispatch connection dies mid-send.
  async function submit(body: string) {
    const files = atts
    if ((!body && !files.length) || sending) return
    sending = true
    sendError = ''
    attErrors = []
    let sid = tab.id
    // clear the box right away so the next (possibly queued) message can be
    // typed while this one runs; restored on failure if it never landed
    text = ''
    autosize()
    let trayCleared = false
    let flight: Promise<unknown> | null = null
    try {
      const isCmd = body.startsWith('/')
      const m = isCmd ? /^\/([a-z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(body.trim()) : null
      const cmd = m ? registry.find(m[1]) : undefined
      // a real session is only needed for prompts and engine commands —
      // built-in commands (dialogs, pickers, prefs) work on a pending tab
      let real: string | null = null
      if (!isCmd || !cmd || cmd.source !== 'builtin') {
        real = tab.pending ? await realize() : tab.id
        sid = real
      }
      if (isCmd && cmd) {
        await cmd.run(real ? ctx(real) : ctx(), m![2] ?? '')
        // only engine commands produce assistant output
        if (cmd.source !== 'builtin' && real) onSent(real)
      } else {
        cancelRetry(sid) // manual send takes over from any pending auto-retry
        tabs.patch(sid, { busy: true }) // optimistic spinner immediately
        // NOTE: error tiles are NOT cleared here — they're history (a record
        // of the failed turn), not a transient banner. A resend that fails
        // again dedupes server-side (UNIQUE sid,msg).
        flight =
          m
            ? oc.runCommand(sid, m[1], m[2] ? [m[2]] : [])
            : oc.prompt(sid, body, sessionModel(sid) ?? $selectedModel ?? undefined, sessionAgent(sid), files.map(toFilePart))
        // attachments ship inside the POST body, so once the dispatch starts
        // they're delivered — clear the tray like the text box (handed back by
        // failedSend if the flight dies before landing). Slash commands can't
        // carry files, so there the tray stays staged for the next prompt.
        atts = []
        trayCleared = true
        onSent(sid)
      }
    } catch (e: any) {
      text = body // fast failure (prep/dispatch): give the message back
      autosize()
      tabs.patch(sid, { busy: false })
      toastErr(e)
      return
    } finally {
      sending = false
    }
    try {
      await flight
    } catch (e: any) {
      tabs.patch(sid, { busy: false })
      await failedSend(sid, body, e, trayCleared ? files : undefined)
    }
  }

  // Failure of a detached send (network drop before the 204, OS sleep). The
  // connection dying does NOT mean the engine missed the message, so only hand
  // it back when the transcript shows no matching user message; blindly
  // restoring made returning to a backgrounded tab "resend" the last message.
  async function failedSend(sid: string, body: string, e: any, files?: Attachment[]) {
    toastErr(e)
    let landed = false
    try {
      const msgs = normalizeMessages(await oc.messages(sid, RECENT_PAGE))
      landed = msgs.some(
        (mm) =>
          mm.role === 'user' &&
          mm.parts.some((p: any) => p.type === 'text' && (p.text ?? '').trim() === body),
      )
    } catch {
      /* engine unreachable — assume it never arrived */
    }
    if (!landed && !text.trim()) {
      // don't clobber a newer draft the user started meanwhile
      text = body
      autosize()
      // hand the attachments back too, unless new ones were staged meanwhile
      if (files?.length && !atts.length) atts = files
    }
  }

  function key(e: KeyboardEvent) {
    if (e.key === 'Escape' && menuOpen) {
      // dismiss menu and clear the staged slash, like the TUI
      e.preventDefault()
      text = ''
      autosize()
      return
    }
    if (menuOpen && filtered.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        sel = (sel + 1) % filtered.length
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        sel = (sel - 1 + filtered.length) % filtered.length
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        pickFromMenu(filtered[sel])
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      const body = text.trim()
      // attachments alone (no text) are a valid send
      if (body || atts.length) submit(body)
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
    if (!ta.value.trim()) {
      ta.style.height = ''
    } else {
      ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
    }
  }
</script>

<div class="composer" class:dropping={dropActive}>
  {#if sendError}
    <div class="error">send failed: {sendError}</div>
  {/if}
  {#each attErrors as ae (ae)}
    <div class="error">{ae}</div>
  {/each}
  {#if dropActive}
    <div class="drophint">drop files to attach</div>
  {/if}
  {#if atts.length}
    <div class="tray">
      {#each atts as a (a.id)}
        <div class="chip" title="{a.filename} · {formatSize(a.size)}">
          {#if isImageMime(a.mime)}
            <img class="cthumb" src={a.dataUrl} alt={a.filename} />
          {:else}
            <span class="cext">{extLabel(a.filename)}</span>
          {/if}
          <span class="cmeta">
            <span class="cname">{midTrunc(a.filename)}</span>
            <span class="csize">{formatSize(a.size)}</span>
          </span>
          <button class="crm" title="Remove attachment" on:click={() => removeAtt(a.id)}>×</button>
        </div>
      {/each}
    </div>
  {/if}
  <div class="box" class:hastray={atts.length}>
    {#if tab.busy}
      <button class="stop" title="Abort current turn" on:click={abort}>■</button>
    {/if}
    <AgentPicker sid={tab.id} />
    <div class="inputwrap">
      <textarea
        bind:this={ta}
        bind:value={text}
        rows="1"
        id="composer-input"
        placeholder="message / for commands"
        on:focus={onTaFocus}
        on:keydown={key}
        on:paste={paste}
        on:input={() => {
          autosize()
          sel = 0
        }}
      ></textarea>
      {#if menuOpen}
        <div class="menu" role="listbox">
          {#each filtered as c, i (c.source + '/' + c.name)}
            <button
              type="button"
              class="row"
              class:active={i === sel}
              title={c.description}
              on:mousedown|preventDefault={() => (sel = i)}
              on:click={() => pickFromMenu(c)}
            >
              <span class="name">/{c.name}</span>
              <span class="desc">{c.description}</span>
              {#if c.source !== 'builtin'}
                <span class="badge {c.source}">{c.source}</span>
              {/if}
            </button>
          {:else}
            <div class="none">no matching command — enter sends as a normal message</div>
          {/each}
          <div class="foot">↑↓ pick · ↵/tab select · esc dismiss</div>
        </div>
      {/if}
    </div>
    <button class="clip" title="Attach files" on:click={pickFiles}>
      <!-- feather "paperclip" -->
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
      </svg>
    </button>
    {#if tab.busy}
      <button class="go queued" disabled={!text.trim() && !atts.length} title="Queue message (runs after the current turn)" on:click={() => submit(text.trim())}>➤</button>
    {:else}
      <button class="go" disabled={!text.trim() && !atts.length} title="Send" on:click={() => submit(text.trim())}>➤</button>
    {/if}
  </div>
  <input type="file" multiple hidden bind:this={fileInput} on:change={onPick} />
</div>

<style>
  .composer {
    position: relative;
    padding: 0 4px 0;
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
  /* attachment tray — flush on top of the input box, reading as one panel */
  .tray {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 7px 8px;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-bottom: none;
    border-radius: 8px 8px 0 0;
    max-height: 118px;
    overflow-y: auto;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    background: var(--bg-hover);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px 5px 4px 4px;
    max-width: 250px;
  }
  .chip .cthumb {
    width: 30px;
    height: 30px;
    border-radius: 4px;
    object-fit: cover;
    border: 1px solid var(--border);
    background: var(--bg-code);
    flex: none;
  }
  .chip .cext {
    font-family: var(--mono);
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.04em;
    color: var(--accent);
    background: rgba(78, 201, 176, 0.08);
    border: 1px solid rgba(78, 201, 176, 0.28);
    border-radius: 4px;
    padding: 9px 5px;
    min-width: 32px;
    text-align: center;
    flex: none;
  }
  .chip .cmeta {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
    line-height: 1.25;
  }
  .chip .cname {
    font-size: 12px;
    white-space: nowrap;
  }
  .chip .csize {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--fg-dim);
  }
  .chip .crm {
    flex: none;
    align-self: flex-start;
    width: 18px;
    height: 18px;
    line-height: 1;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--fg-dim);
    cursor: pointer;
    font-size: 13px;
  }
  .chip .crm:hover {
    color: var(--err);
    background: rgba(244, 135, 113, 0.12);
  }
  .box.hastray {
    border-top-left-radius: 0;
    border-top-right-radius: 0;
  }
  /* file-drag affordance: dashed accent outline + soft glow over the box */
  .composer.dropping .box {
    border-color: var(--accent);
    border-style: dashed;
    box-shadow:
      0 0 0 3px rgba(78, 201, 176, 0.14),
      0 0 22px rgba(78, 201, 176, 0.12);
  }
  .drophint {
    position: absolute;
    top: -11px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 6;
    background: var(--accent);
    color: #14231f;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    padding: 3px 12px;
    border-radius: 999px;
    white-space: nowrap;
    pointer-events: none;
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.45);
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
  .inputwrap {
    flex: 1;
    position: relative;
    min-width: 0;
  }
  textarea {
    width: 100%;
    display: block;
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
  /* floats above the composer, anchored to the input */
  .menu {
    position: absolute;
    bottom: calc(100% + 8px);
    left: 0;
    right: 0;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    max-height: 44vh;
    overflow-y: auto;
    z-index: 80;
    box-shadow: 0 14px 40px rgba(0, 0, 0, 0.5);
    padding: 4px;
  }
  .row {
    display: flex;
    gap: 10px;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: var(--fg);
    padding: 7px 10px;
    cursor: pointer;
    font-size: 13px;
    align-items: baseline;
  }
  .row.active,
  .row:hover {
    background: var(--bg-hover);
  }
  .name {
    font-family: var(--mono);
    color: var(--accent);
    white-space: nowrap;
  }
  .desc {
    flex: 1;
    color: var(--fg-dim);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .badge {
    font-size: 9.5px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border: 1px solid var(--border);
    color: var(--fg-dim);
    border-radius: 4px;
    padding: 0 5px;
    flex-shrink: 0;
  }
  .badge.skill {
    color: #c9a7f7;
    border-color: #5a4472;
  }
  .none {
    padding: 10px;
    color: var(--fg-dim);
    font-size: 12px;
  }
  .foot {
    border-top: 1px solid var(--border);
    margin-top: 4px;
    padding: 5px 12px;
    font-size: 10.5px;
    color: var(--fg-dim);
    user-select: none;
  }
  button.go,
  button.stop,
  button.clip {
    width: 30px;
    height: 30px;
    border-radius: 6px;
    border: none;
    cursor: pointer;
    font-size: 13px;
    flex-shrink: 0;
  }
  .clip {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--fg-dim);
  }
  .clip:hover {
    color: var(--accent);
    border-color: var(--accent);
  }
  .clip svg {
    width: 15px;
    height: 15px;
  }
  .go {
    background: var(--accent);
    color: #fff;
  }
  .go.queued {
    background: transparent;
    border: 1px solid var(--accent);
    color: var(--accent);
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
