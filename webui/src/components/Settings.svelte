<script lang="ts">
  import { tick, onDestroy } from 'svelte'
  import {
    tabs,
    settingsOpen,
    hideSubagents,
    showThinking,
    showTimestamps,
    infoOpen,
    toggleInfo,
    selectedModel,
    sessionAgents,
    recentModels,
    clearRecentModels,
    clearLocalData,
    toast,
  } from '../lib/stores'

  const activeStore = tabs.active

  let closeEl: HTMLButtonElement
  let confirmTimer: ReturnType<typeof setTimeout> | undefined

  function close() {
    settingsOpen.set(false)
  }

  function onKey(e: KeyboardEvent) {
    if (!$settingsOpen) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      cancelConfirm()
      close()
    }
  }

  // focus management follows the dialogs' convention (CommandDialog focuses
  // its first row; some browsers drop focus on just-inserted nodes → retry)
  $: if ($settingsOpen) focusClose()
  async function focusClose() {
    await tick()
    closeEl?.focus()
    setTimeout(() => {
      if ($settingsOpen && document.activeElement !== closeEl) closeEl?.focus()
    }, 60)
  }

  // ---- model recents --------------------------------------------------------
  function wipeRecents() {
    clearRecentModels()
    toast('model recents cleared')
  }

  // ---- destructive: clear all local data ------------------------------------
  let confirming = false
  function askConfirm() {
    confirming = true
    clearTimeout(confirmTimer)
    // stand down automatically if the user walks away mid-confirm
    confirmTimer = setTimeout(() => (confirming = false), 6000)
  }
  function cancelConfirm() {
    confirming = false
    clearTimeout(confirmTimer)
  }
  function doWipe() {
    cancelConfirm()
    clearLocalData()
    // stores hold pre-wipe values in memory; a reload re-seeds everything
    // from the now-clean localStorage (default prefs restored)
    location.reload()
  }
  onDestroy(cancelConfirm)

  // reactive derivations — stores are read inline so template updates never
  // freeze (the frozen-{label()} gotcha)
  $: modelLine = $selectedModel
    ? `${$selectedModel.providerID} / ${$selectedModel.modelID}`
    : 'engine default'
  $: agentPick = $sessionAgents[$activeStore]
</script>

<svelte:window on:keydown={onKey} />

{#if $settingsOpen}
  <div class="settings" role="dialog" aria-label="Settings">
    <header>
      <span class="hgear" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path
            d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
          />
        </svg>
      </span>
      <span class="htitle">Settings</span>
      <!-- svelte-ignore a11y-autofocus -->
      <button class="close" bind:this={closeEl} title="Close settings (Esc)" on:click={close}>✕</button>
    </header>

    <div class="body">
      <div class="col">
        <section>
          <div class="sec">Display</div>
          <label class="row">
            <span class="txt">
              <span class="name">Hide subagents</span>
              <span class="desc">Keep @explore / @general subagent sessions out of the sidebar list.</span>
            </span>
            <input class="native" type="checkbox" bind:checked={$hideSubagents} />
            <span class="switch" aria-hidden="true"></span>
          </label>
          <label class="row">
            <span class="txt">
              <span class="name">Show message timestamps</span>
              <span class="desc">Time markers next to messages in the transcript.</span>
            </span>
            <input class="native" type="checkbox" bind:checked={$showTimestamps} />
            <span class="switch" aria-hidden="true"></span>
          </label>
          <label class="row">
            <span class="txt">
              <span class="name">Always expand thinking blocks</span>
              <span class="desc">Open reasoning blocks by default instead of keeping them collapsed.</span>
            </span>
            <input class="native" type="checkbox" bind:checked={$showThinking} />
            <span class="switch" aria-hidden="true"></span>
          </label>
          <label class="row">
            <span class="txt">
              <span class="name">Info panel open</span>
              <span class="desc">Show the context panel (tokens, cost, todos) on the right.</span>
            </span>
            <!-- infoOpen persists only via toggleInfo(), so this row routes
                through it instead of a direct store bind -->
            <input class="native" type="checkbox" checked={$infoOpen} on:change={toggleInfo} />
            <span class="switch" aria-hidden="true"></span>
          </label>
        </section>

        <section>
          <div class="sec">Session defaults</div>
          <div class="grid">
            <span class="k">model</span>
            <span class="v" title="New prompts use this model">{modelLine}</span>
            <span class="k">agent</span>
            <span class="v" title="Agent pick for the active session (chosen per session in the composer)">
              {#if $activeStore}{agentPick ? agentPick : 'Auto (session default)'}{:else}— no session open{/if}
            </span>
          </div>
          <p class="note">
            Changed from the composer and the model picker in the top bar — shown here read-only.
          </p>
        </section>

        <section>
          <div class="sec">Model recents</div>
          {#if $recentModels.length}
            <div class="rechead">
              <span class="count">{$recentModels.length} saved <span class="cap">(max 12)</span></span>
              <button class="ghostbtn" on:click={wipeRecents}>Clear recents</button>
            </div>
            <ul class="reclist">
              {#each $recentModels as r (r.providerID + '/' + r.modelID)}
                <li>{r.providerID} <span class="sep">/</span> {r.modelID}</li>
              {/each}
            </ul>
          {:else}
            <div class="empty">no recent models yet — they fill in as you pick models</div>
          {/if}
        </section>

        <section>
          <div class="sec danger-title">Danger zone</div>
          <div class="danger">
            <div class="drow">
              <span class="txt">
                <span class="name">Clear all local data</span>
                <span class="desc">
                  Erases every setting stored in this browser — display preferences, model &amp;
                  agent picks, recent models, restored tabs. Sessions on the server are not touched.
                  The page reloads afterwards.
                </span>
              </span>
              {#if !confirming}
                <button class="wipe" on:click={askConfirm}>Clear all…</button>
              {:else}
                <span class="confirm">
                  <span class="ctext">Erase everything?</span>
                  <button class="wipe yes" on:click={doWipe}>Yes, erase</button>
                  <button class="ghostbtn" on:click={cancelConfirm}>Keep</button>
                </span>
              {/if}
            </div>
          </div>
        </section>

        <footer>Preferences live only in this browser's localStorage — nothing is sent to the server.</footer>
      </div>
    </div>
  </div>
{/if}

<style>
  /* page-like view taking over the content area. FIXED, not anchored to
     <main>: on narrow phones both side panels can legitimately squeeze main
     to zero width, which would collapse an inset:0 child. A full-viewport
     page reads the same on every breakpoint and always has a way back. */
  .settings {
    position: fixed;
    inset: 0;
    z-index: 50;
    background: var(--bg);
    display: flex;
    flex-direction: column;
    animation: rise 0.16s ease-out;
  }
  @keyframes rise {
    from {
      transform: translateY(8px);
      opacity: 0;
    }
  }
  header {
    flex: none;
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-panel);
  }
  .hgear {
    color: var(--accent);
    display: inline-flex;
  }
  .hgear svg {
    display: block;
  }
  .htitle {
    font-weight: 600;
    font-size: 13px;
    letter-spacing: 0.02em;
  }
  .close {
    margin-left: auto;
    width: 28px;
    height: 28px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 6px;
    color: var(--fg-dim);
    font-size: 13px;
    cursor: pointer;
  }
  .close:hover,
  .close:focus-visible {
    background: var(--bg-hover);
    color: var(--fg);
    outline: none;
  }

  .body {
    flex: 1;
    overflow-y: auto;
    padding: 20px 16px 32px;
  }
  .col {
    max-width: 640px;
    margin: 0 auto;
  }
  .sec {
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--fg-dim);
    margin: 22px 0 8px;
  }
  section:first-child .sec {
    margin-top: 0;
  }

  /* preference row: label/desc left, switch right */
  .row {
    position: relative; /* anchors the visually-hidden native checkbox */
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 9px 10px;
    border-radius: 8px;
    cursor: pointer;
    user-select: none;
  }
  .row:hover {
    background: var(--bg-hover);
  }
  .txt {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .name {
    font-size: 12.5px;
    color: var(--fg);
  }
  .desc {
    font-size: 11.5px;
    line-height: 1.45;
    color: var(--fg-dim);
  }

  /* switch — native checkbox drives state, track/knob are styled */
  .native {
    position: absolute;
    opacity: 0;
    width: 1px;
    height: 1px;
    pointer-events: none;
  }
  .switch {
    flex: none;
    position: relative;
    width: 34px;
    height: 18px;
    border-radius: 9px;
    background: var(--bg-hover);
    border: 1px solid var(--border);
    transition: background 0.12s ease-out;
  }
  .switch::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--fg-dim);
    transition: transform 0.12s ease-out, background 0.12s ease-out;
  }
  .native:checked + .switch {
    background: color-mix(in srgb, var(--accent) 32%, transparent);
    border-color: var(--accent);
  }
  .native:checked + .switch::after {
    transform: translateX(16px);
    background: var(--accent);
  }
  .native:focus-visible + .switch {
    outline: 1px solid var(--accent);
    outline-offset: 2px;
  }

  /* read-only picks — same key/value grid as the info panel */
  .grid {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 6px 14px;
    font-size: 12.5px;
    padding: 4px 10px;
  }
  .k {
    color: var(--fg-dim);
  }
  .v {
    text-align: right;
    font-family: var(--mono);
    font-size: 11.5px;
    overflow-wrap: anywhere;
  }
  .note {
    margin: 6px 10px 0;
    font-size: 11px;
    color: var(--fg-dim);
  }

  /* model recents */
  .rechead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 2px 10px 4px;
  }
  .count {
    font-size: 12px;
    color: var(--fg);
  }
  .cap {
    color: var(--fg-dim);
    font-size: 11px;
  }
  .reclist {
    margin: 2px 0 0;
    padding: 6px 10px;
    list-style: none;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--fg-dim);
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .reclist li {
    padding: 2px 0;
    overflow-wrap: anywhere;
  }
  .sep {
    opacity: 0.5;
  }
  .empty {
    padding: 4px 10px;
    font-size: 12px;
    color: var(--fg-dim);
  }

  .ghostbtn {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--fg-dim);
    font-size: 11.5px;
    padding: 4px 10px;
    cursor: pointer;
    flex: none;
  }
  .ghostbtn:hover {
    color: var(--fg);
    border-color: var(--fg-dim);
  }

  /* danger zone */
  .danger-title {
    color: var(--err);
  }
  .danger {
    border: 1px solid color-mix(in srgb, var(--err) 55%, var(--border));
    background: color-mix(in srgb, var(--err) 7%, transparent);
    border-radius: 10px;
    padding: 12px 14px;
  }
  .drow {
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .drow .name {
    color: var(--err);
    font-weight: 600;
  }
  .wipe {
    flex: none;
    background: color-mix(in srgb, var(--err) 18%, transparent);
    border: 1px solid var(--err);
    border-radius: 6px;
    color: var(--err);
    font-size: 11.5px;
    font-weight: 600;
    padding: 5px 12px;
    cursor: pointer;
  }
  .wipe:hover {
    background: var(--err);
    color: #fff;
  }
  .confirm {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .ctext {
    font-size: 11.5px;
    color: var(--err);
    white-space: nowrap;
  }

  footer {
    margin-top: 26px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
    font-size: 11px;
    color: var(--fg-dim);
  }

  @media (max-width: 480px) {
    header {
      padding: 8px 12px;
    }
    .body {
      padding: 14px 10px 28px;
    }
    .row,
    .grid {
      padding-left: 4px;
      padding-right: 4px;
    }
    .drow {
      flex-direction: column;
      align-items: stretch;
    }
    .confirm {
      justify-content: flex-end;
    }
  }
</style>
