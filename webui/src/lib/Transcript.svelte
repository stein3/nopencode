<script lang="ts">
  import { getTranscript, type Transcript as T } from './api'
  import { md } from './markdown'

  export let sessionId: string
  export let scrollTo: string | null = null

  let data: T | null = null
  let error: string | null = null
  let lastLoaded: string | null = null

  function textOf(parts: { type: string; text?: string }[]): string {
    return parts.filter((p) => p.type === 'text' && p.text).map((p) => p.text).join('\n\n')
  }

  async function load(id: string) {
    error = null
    data = await getTranscript(id)
    lastLoaded = id
    queueMicrotask(() => {
      if (scrollTo) {
        document.getElementById('m-' + scrollTo)?.scrollIntoView()
      } else {
        const el = document.querySelector('.transcript')
        el?.scrollTo(0, el.scrollHeight)
      }
    })
  }

  $: if (sessionId && sessionId !== lastLoaded && !error) {
    load(sessionId).catch((e) => (error = String(e)))
  }
</script>

<div class="transcript">
  {#if error}
    <div class="transcript-empty">error: {error}</div>
  {:else if !data}
    <div class="transcript-empty">loading…</div>
  {:else}
    {#each data.messages as m (m.id)}
      {@const body = textOf(m.parts)}
      {@const others = m.parts.filter((p) => p.type !== 'text')}
      <div id={'m-' + m.id} class="msg msg-{m.role === 'user' ? 'user' : 'assistant'}">
        <div class="msg-meta">
          <span>{m.role}</span>
          {#if m.modelID}<span>{m.providerID}/{m.modelID}</span>{/if}
          <span>{new Date(m.timeCreated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </div>

        {#if m.role === 'user'}
          <div class="msg-user">{body}</div>
        {:else if body}
          <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized via DOMPurify -->
          <div class="body">{@html md(body)}</div>
        {/if}

        {#each others as p, i (p.id ?? i)}
          {#if p.type === 'reasoning' && p.text}
            <details class="reasoning">
              <summary>thinking</summary>
              <pre>{p.text}</pre>
            </details>
          {:else if p.type === 'tool'}
            <details class="tool">
              <summary>
                {p.tool}
                <span class="status-badge" class:status-error={p.status === 'error'}
                  class:status-done={p.status === 'completed'}>{p.status}</span
                >
                {#if p.truncated}<span class="trunc-flag">(truncated)</span>{/if}
              </summary>
              {#if p.input}<pre>in: {p.input}</pre>{/if}
              {#if p.output}<pre>out: {p.output}</pre>{/if}
            </details>
          {/if}
        {/each}
      </div>
    {/each}
  {/if}
</div>

<style>
  .transcript {
    height: 100vh;
  }
</style>
