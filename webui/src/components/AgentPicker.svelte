<script lang="ts">
  import { onMount } from 'svelte'
  import { oc } from '../lib/api'
  import { sessionAgents, setSessionAgent } from '../lib/stores'
  import { titleName } from '../lib/util'

  // scoped to THIS pane's tab/session — a pick here never touches other tabs
  export let sid: string

  interface AgentInfo {
    name: string
    mode?: string
    description?: string
    color?: string | null
  }

  let agents: AgentInfo[] = []
  let open = false
  let wrap: HTMLDivElement

  // One roster fetch shared by every mounted Composer pane (tab panes
  // multiply). Only a successful NON-empty result is cached, so a failed or
  // empty fetch renders nothing here but retries on the next pane mount.
  let rosterCache: AgentInfo[] | null = null
  async function loadRoster(): Promise<AgentInfo[]> {
    if (rosterCache) return rosterCache
    const list = await oc.agents().catch(() => [])
    const eligible = (list ?? []).filter((a) => a.mode !== 'subagent' && !a.hidden)
    if (eligible.length) rosterCache = eligible
    return eligible
  }

  onMount(async () => {
    agents = await loadRoster()
  })

  // reactive statements, NOT functions called in the template — stores/vars
  // read inside a function body are invisible to the compiler and the label
  // freezes (the ModelPicker `{label()}` bug)
  $: cur = $sessionAgents[sid]
  $: curLabel = cur ? titleName(cur) : 'Auto'
  $: curColor = cur ? (agents.find((a) => a.name === cur)?.color ?? null) : null

  function pick(name: string | undefined) {
    setSessionAgent(sid, name) // undefined = back to session/engine default
    open = false
  }

  function onOutside(e: PointerEvent) {
    if (!open || !wrap) return
    if (!wrap.contains(e.target as Node)) open = false
  }

  function onKeydown(e: KeyboardEvent) {
    if (open && e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      open = false
    }
  }
</script>

<svelte:window on:pointerdown={onOutside} on:keydown={onKeydown} />

{#if agents.length}
  <div class="wrap" bind:this={wrap}>
    <button
      class="cur"
      class:open={open}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-label={'Agent for new messages in this session: ' + curLabel}
      title={cur ? 'Agent for new messages (this session): ' + curLabel : 'Agent for new messages (this session): Auto (session default)'}
      on:click={() => (open = !open)}
    >
      {#if cur && curColor}
        <span class="dot" style="background:{curColor}"></span>
      {/if}
      <span class="lbl">{curLabel}</span>
      <span class="chev">▾</span>
    </button>
    {#if open}
      <div class="menu" role="listbox" aria-label="Agent">
        <button
          class="m auto"
          class:on={!cur}
          role="option"
          aria-selected={!cur}
          title="Use the session's default agent"
          on:click={() => pick(undefined)}
        >
          <span class="nm">Auto</span>
          <span class="ds">session default</span>
        </button>
        {#each agents as a (a.name)}
          <button
            class="m"
            class:on={cur === a.name}
            role="option"
            aria-selected={cur === a.name}
            title={a.description || titleName(a.name)}
            on:click={() => pick(a.name)}
          >
            <span class="nm">
              {#if a.color}<span class="dot" style="background:{a.color}"></span>{/if}
              {titleName(a.name)}
            </span>
            {#if a.description}<span class="ds">{a.description}</span>{/if}
          </button>
        {:else}
          <div class="none">no selectable agents</div>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .wrap {
    position: relative;
    flex: none; /* never fight the textarea's flex: 1 */
    align-self: center;
  }
  /* tokens mirror ModelPicker's collapsed button */
  .cur {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--fg-dim);
    border-radius: 6px;
    font-size: 11px;
    padding: 2px 8px;
    cursor: pointer;
    max-width: 120px;
  }
  .cur:hover {
    color: var(--fg);
    border-color: var(--accent);
  }
  /* open-state affordance — no transition: ModelPicker has none either */
  .cur.open {
    border-color: var(--accent);
    color: var(--fg);
  }
  .cur.open .chev {
    transform: rotate(180deg);
  }
  .lbl {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chev {
    flex-shrink: 0;
    opacity: 0.7;
    font-size: 9px;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  /* opens UPWARD — the composer sits at viewport bottom (slash-menu precedent),
     unlike the topbar ModelPicker whose menu drops down */
  .menu {
    position: absolute;
    bottom: calc(100% + 14px);
    left: 0;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    min-width: 230px;
    max-width: 320px;
    max-height: 44vh;
    overflow-y: auto;
    z-index: 80;
    box-shadow: 0 18px 48px rgba(0, 0, 0, 0.65);
    padding: 4px;
  }
  .m {
    display: flex;
    flex-direction: column;
    gap: 1px;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    border-left: 3px solid transparent;
    border-radius: 5px;
    color: var(--fg);
    font-size: 12.5px;
    padding: 6px 10px;
    cursor: pointer;
  }
  .m:hover {
    background: var(--bg-hover);
  }
  .m.on {
    border-left-color: var(--accent);
    background: var(--bg-hover);
  }
  .m.on .nm {
    color: var(--accent);
  }
  .nm {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ds {
    color: var(--fg);
    opacity: 0.72;
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .auto {
    border-bottom: 1px solid var(--border);
    border-radius: 5px 5px 0 0;
    margin-bottom: 3px;
    padding-bottom: 5px;
  }
  .none {
    padding: 10px;
    color: var(--fg-dim);
    font-size: 12px;
  }
  /* narrow screens: keep the composer's textarea usable — clamp harder */
  @media (max-width: 480px) {
    .cur {
      max-width: 78px;
    padding: 2px 6px;
  }
  }
</style>
