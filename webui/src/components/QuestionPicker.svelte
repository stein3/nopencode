<script lang="ts">
  import { answerQuestion, dismissQuestion } from '../lib/questions'
  import type { PendingQuestion } from '../lib/stores'

  // Interactive picker for a pending engine question request. Single-question
  // requests without a custom field answer on click; otherwise picks are
  // collected and submitted together (engine wants one label array per
  // question, in order).
  export let req: PendingQuestion

  let picks: string[][] = []
  let custom: string[] = []
  let busy = false

  $: qs = req.questions ?? []
  // reset per-question state when a different request arrives
  $: if (req) {
    picks = qs.map(() => [] as string[])
    custom = qs.map(() => '')
  }

  function toggle(i: number, label: string) {
    const cur = picks[i]
    picks[i] = cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]
  }

  function ready(): boolean {
    return qs.every((q: any, i: number) => picks[i]?.length > 0 || (custom[i] ?? '').trim().length > 0)
  }

  function needsSubmit(): boolean {
    return qs.length > 1 || qs.some((q: any) => q.custom || q.multiple)
  }

  function answerAt(i: number, label: string) {
    const answers = qs.map((_: any, k: number) => (k === i ? [label] : picks[k]?.length ? picks[k] : (custom[k] ?? '').trim() ? [custom[k].trim()] : []))
    submit(answers)
  }

  function submit(answers?: string[][]) {
    if (busy) return
    const a =
      answers ??
      qs.map((_: any, i: number) =>
        picks[i]?.length ? picks[i] : (custom[i] ?? '').trim() ? [custom[i].trim()] : [],
      )
    if (!a.every((x) => x.length)) return
    busy = true
    answerQuestion(req, a).finally(() => (busy = false))
  }

  function reject() {
    if (busy) return
    busy = true
    dismissQuestion(req).finally(() => (busy = false))
  }
</script>

<div class="qpick">
  {#each qs as q, i (req.id + '/' + i)}
    <div class="qa">
      <div class="qq">{q.header ? q.header + ': ' : ''}{q.question}</div>
      {#each q.options ?? [] as opt (opt.label)}
        <button
          type="button"
          class="opt pickable"
          class:picked={picks[i]?.includes(opt.label)}
          disabled={busy}
          on:click={() => (qs.length === 1 && !q.custom && !q.multiple ? answerAt(i, opt.label) : toggle(i, opt.label))}
        >
          <span class="mark">{picks[i]?.includes(opt.label) ? '✓' : ''}</span>
          <span class="otext"><b>{opt.label}</b>{#if opt.description}<span class="odesc"> — {opt.description}</span>{/if}</span>
        </button>
      {/each}
      {#if q.custom}
        <input
          class="custom"
          placeholder="Other…"
          disabled={busy}
          on:keydown={(e) => {
            if (e.key === 'Enter' && ready()) submit()
            e.stopPropagation()
          }}
        />
      {/if}
    </div>
  {/each}
  <div class="qacts">
    {#if needsSubmit()}
      <button type="button" class="send" disabled={busy || !ready()} on:click={() => submit()}>
        {busy ? 'sending…' : 'submit'}
      </button>
    {/if}
    <button type="button" class="reject" disabled={busy} title="Reject the question (the model sees a rejection)" on:click={reject}>
      dismiss
    </button>
  </div>
</div>

<style>
  .qpick {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .qq {
    color: var(--fg);
    font-size: 12.5px;
    margin-bottom: 2px;
  }
  .opt {
    display: flex;
    gap: 8px;
    align-items: baseline;
    width: 100%;
    text-align: left;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--fg);
    border-radius: 6px;
    padding: 5px 10px;
    font-size: 12.5px;
    cursor: pointer;
  }
  .opt:hover {
    border-color: var(--accent);
  }
  .opt.picked {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }
  .opt:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .mark {
    width: 12px;
    flex-shrink: 0;
    color: var(--accent);
  }
  .otext b {
    font-weight: 600;
  }
  .odesc {
    color: var(--fg-dim);
    font-size: 12px;
  }
  .custom {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--fg);
    font: inherit;
    font-size: 12.5px;
    padding: 5px 10px;
  }
  .custom:focus {
    outline: none;
    border-color: var(--accent);
  }
  .qacts {
    display: flex;
    gap: 8px;
    margin-top: 4px;
  }
  .qacts button {
    border: none;
    border-radius: 6px;
    font-size: 12px;
    padding: 4px 14px;
    cursor: pointer;
  }
  .send {
    background: var(--accent);
    color: #fff;
  }
  .send:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .reject {
    background: transparent;
    color: var(--fg-dim);
    border: 1px solid var(--border) !important;
  }
  .reject:hover {
    color: var(--fg);
  }
</style>
