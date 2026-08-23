<script lang="ts">
  import { onMount } from 'svelte'
  import Sidebar from './components/Sidebar.svelte'
  import TabsBar from './components/Tabs.svelte'
  import Transcript from './components/Transcript.svelte'
  import Composer from './components/Composer.svelte'
  import Footer from './components/Footer.svelte'
  import { hist, oc } from './lib/api'
  import { tabs, permissions, sidebarOpen, selectedModel, paletteOpen, infoOpen, toggleInfo, type Tab } from './lib/stores'
  import CommandPalette from './components/CommandPalette.svelte'
  import ModelPicker from './components/ModelPicker.svelte'
  import InfoPanel from './components/InfoPanel.svelte'
  import { startEvents, normalizeMessages } from './lib/sse'
  import { answerPermission, refreshPermissions } from './lib/permissions'
  import { initHotkeys } from './lib/hotkeys'

  let composer: Composer

  function openTab(t: Tab) {
    tabs.open(t)
  }

  async function openHistory(id: string, anchor?: string) {
    try {
      const msgs = await hist.messages(id)
      const s = await hist.sessions().then((all) => all.find((x) => x.id === id))
      openTab({
        id,
        title: s?.title || id.slice(0, 14),
        live: false,
        messages: msgs.map((m) => ({
          id: m.id,
          role: m.role,
          time: { created: m.time },
          parts: m.parts,
        })),
      })
      if (anchor)
        requestAnimationFrame(() =>
          document.getElementById(`m-${anchor}`)?.scrollIntoView({ block: 'start' }),
        )
    } catch (e: any) {
      alert(`open failed: ${e.message}`)
    }
  }

  async function openLive(id: string, title?: string) {
    try {
      const msgs = await oc.messages(id)
      tabs.patch(id, { messages: normalizeMessages(msgs), live: true })
    } catch {
      // not an engine session (pure history) — fall back to history view
      return openHistory(id)
    }
    if (title) tabs.patch(id, { title })
    const st = await oc.status().catch(
      () => ({}) as Record<string, { type?: string; state?: string }>,
    )
    tabs.patch(id, { busy: (st[id]?.type ?? st[id]?.state) === 'busy' })
  }

  async function newChat() {
    try {
      const s = await oc.createSession()
      tabs.patch(s.id, { title: 'New chat' })
      openTab({ id: s.id, title: 'New chat', messages: [], live: true })
      composer?.focus()
    } catch (e: any) {
      alert(`create session failed: ${e.message}`)
    }
  }

  function closeTab(id: string) {
    tabs.close(id)
  }

  onMount(() => {
    startEvents()
    ;(async () => {
      // auto-open the most recent session
      try {
        const all = await hist.sessions()
        const latest = all.sort((a, b) => b.updated - a.updated)[0]
        if (latest) {
          openTab({ id: latest.id, title: latest.title || latest.id.slice(0, 12), messages: [], live: true })
          await openLive(latest.id, latest.title)
        }
      } catch {
        /* engine down; sidebar still usable */
      }
    })()

    return initHotkeys({
      focusSearch: () => document.getElementById('sidebar-search')?.focus(),
      focusComposer: () => composer?.focus(),
      newChat,
      closeTab: () => closeTab(tabs.getActive()),
      cycleTabs: (dir) => cycle(dir),
      jumpTab: (n) => jump(n),
      openPalette: () => paletteOpen.set(true),
    })
  })

  let order: string[] = []
  $: order = $tabs.map((t) => t.id)
  const active = tabs.active

  function cycle(dir: 1 | -1) {
    const cur = order.indexOf(tabs.getActive())
    if (cur === -1 || !order.length) return
    tabs.setActive(order[(cur + dir + order.length) % order.length])
  }
  function jump(n: number) {
    if (order[n - 1]) tabs.setActive(order[n - 1])
  }

  function onSent(sessionId: string) {
    tabs.patch(sessionId, { busy: true, live: true })
    // pull immediately so the user message shows up without waiting for SSE
    setTimeout(() => openLive(sessionId).catch(() => {}), 150)
  }
</script>

<div class="app" class:nosidebar={!$sidebarOpen}>
  {#if $sidebarOpen}
    <Sidebar onOpenHistory={openHistory} onNewChat={newChat} />
  {/if}
  <main>
    <div class="topbar">
      <button class="burger" title="Toggle sidebar" on:click={() => sidebarOpen.update((v) => !v)}>
        ☰
      </button>
      <div class="spacer"></div>
      <ModelPicker />
      <button class="burger" title="Toggle info panel" on:click={toggleInfo}>▤</button>
      {#if $permissions.length}
        <div class="perm">
          ⚠ {$permissions.length} permission{$permissions.length > 1 ? 's' : ''} pending
          {#each $permissions as p (p.id)}
            <span class="ptitle">{p.title ?? p.type ?? p.id.slice(0, 10)}</span>
            <button class="ok" on:click={() => answerPermission(p, 'once')}>once</button>
            <button class="always" on:click={() => answerPermission(p, 'always')}>always</button>
            <button class="deny" on:click={() => answerPermission(p, 'reject')}>deny</button>
          {/each}
          <button class="refresh" title="refresh" on:click={refreshPermissions}>↻</button>
        </div>
      {/if}
    </div>
    <TabsBar onClose={closeTab} onNewChat={newChat} />
    {#each $tabs as t (t.id)}
      <div class="tabpane" style:display={$active === t.id ? 'flex' : 'none'}>
        <Transcript tab={t} />
        <Composer bind:this={composer} tab={t} onSent={onSent} />
        <Footer tab={t} />
      </div>
    {:else}
      <div class="notabs">Ctrl+T to start a chat · pick a session from the sidebar</div>
    {/each}
    <CommandPalette sessionId={tabs.getActive() || null} onDone={() => composer?.focus()} />
  </main>
  {#if $infoOpen}
    <InfoPanel tab={$tabs.find((t) => t.id === $active) ?? null} />
  {/if}
</div>

<style>
  .app {
    display: flex;
    height: 100vh;
    overflow: hidden;
  }
  main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .topbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: var(--bg-panel);
    border-bottom: 1px solid var(--border);
    min-height: 34px;
    box-sizing: border-box;
  }
  .burger {
    background: transparent;
    border: none;
    color: var(--fg-dim);
    font-size: 15px;
    cursor: pointer;
    padding: 2px 8px;
    border-radius: 4px;
  }
  .burger:hover {
    background: var(--bg-hover);
    color: var(--fg);
  }
  .spacer {
    flex: 1;
  }
  .perm {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--warn);
    flex-wrap: wrap;
  }
  .ptitle {
    background: rgba(255, 170, 0, 0.12);
    border: 1px solid var(--warn);
    border-radius: 4px;
    padding: 1px 6px;
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .perm button {
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 11.5px;
    padding: 2px 8px;
  }
  .ok,
  .always {
    background: #2d5a2d;
    color: #c9f7c9;
  }
  .deny {
    background: #5a2d2d;
    color: #f7c9c9;
  }
  .refresh {
    background: transparent;
    color: var(--fg-dim);
  }
  .tabpane {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .notabs {
    margin: auto;
    color: var(--fg-dim);
  }
  @media (max-width: 900px) {
    .app.nosidebar :global(.sidebar),
    .nosidebar :global(aside) {
      display: none;
    }
  }
</style>
