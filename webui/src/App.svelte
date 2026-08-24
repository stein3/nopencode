<script lang="ts">
  import { onMount } from 'svelte'
  import Sidebar from './components/Sidebar.svelte'
  import TabsBar from './components/Tabs.svelte'
  import Transcript from './components/Transcript.svelte'
  import Composer from './components/Composer.svelte'
  import Footer from './components/Footer.svelte'
  import { hist, oc } from './lib/api'
  import { tabs, permissions, sidebarOpen, selectedModel, paletteOpen, infoOpen, toggleInfo, toastMsg, patchMetrics, type Tab } from './lib/stores'
  import CommandPalette from './components/CommandPalette.svelte'
  import CommandDialog from './components/CommandDialog.svelte'
  import ModelPicker from './components/ModelPicker.svelte'
  import InfoPanel from './components/InfoPanel.svelte'
  import { startEvents, applyMessages } from './lib/sse'
  import { answerPermission, refreshPermissions } from './lib/permissions'
  import { initHotkeys } from './lib/hotkeys'

  let composers: Record<string, Composer> = {}
  let diffOpen = false

  function focusActiveComposer() {
    composers[tabs.getActive()]?.focus()
  }

  function openTab(t: Tab) {
    tabs.open(t)
  }

  function onNewChatEvent() {
    newChat()
  }
  function onFocusSidebar() {
    sidebarOpen.update((v) => (v ? v : true))
    setTimeout(() => document.getElementById('sidebar-search')?.focus(), 50)
  }

  async function openHistory(id: string, anchor?: string, allowLive = true) {
    // Prefer the engine-backed (live) view so the info panel can populate
    // cost/tokens/todos; fall back to the pure-history snapshot only when the
    // engine doesn't know the session or is down.
    let ok = false
    if (allowLive) {
      try {
        const s = await oc.session(id)
        openTab({ id, title: s?.title || id.slice(0, 14), messages: [], live: true })
        await openLive(id)
        ok = true
      } catch {
        /* not an engine session / engine down — history view below */
      }
    }
    if (!ok) {
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
      } catch (e: any) {
        alert(`open failed: ${e.message}`)
      }
    }
    if (anchor)
      requestAnimationFrame(() =>
        document.getElementById(`m-${anchor}`)?.scrollIntoView({ block: 'start' }),
      )
  }

  async function openLive(id: string, title?: string) {
    try {
      const [msgs, s] = await Promise.all([
        oc.messages(id),
        oc.session(id).catch(() => null as any),
      ])
      applyMessages(id, msgs)
      tabs.patch(id, { live: true, revert: s?.revert ?? null })
      // session cost is engine-maintained; the messages payload can't derive it
      if (typeof s?.cost === 'number') patchMetrics(id, { cost: s.cost })
      // the picker reflects the model this session actually uses; switching
      // tabs therefore carries the "last used" model into new chats
      const m = s?.model
      if (m?.providerID && m?.id) selectedModel.save({ providerID: m.providerID, modelID: m.id })
    } catch {
      // not an engine session (pure history) — fall back to history view;
      // allowLive=false prevents openHistory ↔ openLive recursion
      return openHistory(id, undefined, false)
    }
    if (title) tabs.patch(id, { title })
    const st = await oc.status().catch(
      () => ({}) as Record<string, { type?: string; state?: string }>,
    )
    tabs.patch(id, { busy: (st[id]?.type ?? st[id]?.state) === 'busy' })
  }

  // New tabs are purely local until the first message; the session is
  // created on demand so abandoned ctrl+t's never litter the engine.
  function newChat() {
    openTab({
      id: 'pending-' + Math.random().toString(36).slice(2, 10),
      title: 'New Session',
      messages: [],
      live: true,
      pending: true,
    })
    focusActiveComposer()
  }

  async function realizeSession(tabId: string): Promise<string> {
    const t = tabs.snapshot(tabId)
    if (!t) throw new Error('tab closed')
    if (!t.pending) return tabId
    const s = await oc.createSession()
    tabs.rekey(tabId, { ...t, id: s.id, pending: false })
    return s.id
  }

  function closeTab(id: string) {
    tabs.close(id)
  }

  onMount(() => {
    startEvents()
    window.addEventListener('oc:new-chat', onNewChatEvent)
    document.addEventListener('oc:focus-sidebar', onFocusSidebar)
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

    const removeHotkeys = initHotkeys({
      focusSearch: () => document.getElementById('sidebar-search')?.focus(),
      focusComposer: () => focusActiveComposer(),
      newChat,
      closeTab: () => closeTab(tabs.getActive()),
      cycleTabs: (dir) => cycle(dir),
      jumpTab: (n) => jump(n),
      openPalette: () => paletteOpen.set(true),
      toggleDiff: () => (diffOpen = !diffOpen),
    })
    window.addEventListener('touchstart', swipeStart, { passive: true })
    window.addEventListener('touchmove', swipeMove, { passive: true })
    window.addEventListener('touchend', swipeEnd)
    window.addEventListener('touchcancel', swipeEnd)
    return () => {
      removeHotkeys()
      window.removeEventListener('oc:new-chat', onNewChatEvent)
      document.removeEventListener('oc:focus-sidebar', onFocusSidebar)
      window.removeEventListener('touchstart', swipeStart)
      window.removeEventListener('touchmove', swipeMove)
      window.removeEventListener('touchend', swipeEnd)
      window.removeEventListener('touchcancel', swipeEnd)
    }
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

  // ---- mobile edge swipes: open/close the panels ---------------------------
  // Left edge → sidebar, right edge → info panel. Only horizontal-dominant
  // drags count, so normal vertical scrolling is untouched. Open gestures
  // must start within SWIPE_EDGE of a screen edge; close gestures start
  // anywhere over the already-open panel. The zone is deliberately wide:
  // starting a touch within a few px of the bezel fights the browser's own
  // back/forward edge swipes.
  const SWIPE_EDGE = 80
  const SWIPE_DIST = 46

  let swipeTouch: number | null = null
  let swipeX = 0
  let swipeY = 0
  let swipeFromLeft = false
  let swipeFromRight = false
  let swipeOverSidebar = false
  let swipeOverInfo = false

  function inHorizScroller(el: Element | null): boolean {
    let n = el as HTMLElement | null
    while (n && n !== document.body) {
      if (n.scrollWidth > n.clientWidth + 1 && /(auto|scroll)/.test(getComputedStyle(n).overflowX))
        return true
      n = n.parentElement
    }
    return false
  }

  function swipeStart(e: TouchEvent) {
    if (swipeTouch !== null) return // one gesture at a time
    if (!window.matchMedia('(max-width: 900px)').matches) return
    const t = e.changedTouches[0]
    const el = t.target as Element | null
    // the wide catch area now overlaps content — never hijack drags that
    // belong to form controls, editable text, or horizontally-scrollable
    // blocks like code
    if (
      el?.closest?.('input, textarea, select') ||
      (el as HTMLElement | null)?.isContentEditable ||
      inHorizScroller(el)
    )
      return
    swipeOverSidebar = !!el?.closest?.('.sidebar')
    swipeOverInfo = !!el?.closest?.('aside.info')
    swipeFromLeft = t.clientX <= SWIPE_EDGE
    swipeFromRight = window.innerWidth - t.clientX <= SWIPE_EDGE
    const actionable =
      ($sidebarOpen && swipeOverSidebar) ||
      ($infoOpen && swipeOverInfo) ||
      (!$sidebarOpen && swipeFromLeft) ||
      (!$infoOpen && swipeFromRight)
    if (!actionable) return
    swipeTouch = t.identifier
    swipeX = t.clientX
    swipeY = t.clientY
  }

  function swipeMove(e: TouchEvent) {
    if (swipeTouch === null) return
    const t = Array.from(e.changedTouches).find((x) => x.identifier === swipeTouch)
    if (!t) return
    const dx = t.clientX - swipeX
    const dy = t.clientY - swipeY
    // commit once the drag is clearly horizontal and long enough
    if (Math.abs(dx) < SWIPE_DIST || Math.abs(dx) < Math.abs(dy) * 1.4) return
    swipeTouch = null // consumed — one gesture, at most one action
    if ($sidebarOpen && swipeOverSidebar) {
      if (dx < 0) sidebarOpen.set(false) // push the drawer away
    } else if (!$sidebarOpen && swipeFromLeft && dx > 0) {
      sidebarOpen.set(true)
    } else if ($infoOpen && swipeOverInfo) {
      if (dx > 0) infoOpen.set(false)
    } else if (!$infoOpen && swipeFromRight && dx < 0) {
      infoOpen.set(true)
    }
  }

  function swipeEnd(e: TouchEvent) {
    if (
      swipeTouch !== null &&
      Array.from(e.changedTouches).some((x) => x.identifier === swipeTouch)
    )
      swipeTouch = null
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
      <button
        class="burger"
        class:on={diffOpen}
        title="Toggle diff pane (Ctrl+D)"
        on:click={() => (diffOpen = !diffOpen)}
      >
        ⑂
      </button>
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
        <Transcript tab={t} active={t.id === $active} />
        <Composer
          bind:this={composers[t.id]}
          tab={t}
          onSent={onSent}
          realize={() => realizeSession(t.id)}
        />
        <Footer tab={t} />
      </div>
    {:else}
      <div class="notabs">Ctrl+T to start a chat · pick a session from the sidebar</div>
    {/each}
    <CommandPalette
      sessionId={tabs.snapshot(tabs.getActive())?.pending ? null : tabs.getActive() || null}
      onDone={() => focusActiveComposer()}
    />
    <CommandDialog />
    {#if $toastMsg}
      <div class="toast">{$toastMsg}</div>
    {/if}
  </main>
  {#if $infoOpen}
    <InfoPanel tab={$tabs.find((t) => t.id === $active) ?? null} />
  {/if}
  {#if diffOpen}
    <div class="diffwrap">
      {#await import('./components/DiffPane.svelte') then DiffPane}
        <DiffPane.default
          sessionId={tabs.snapshot(tabs.getActive())?.pending ? '' : tabs.getActive()}
          visible={diffOpen}
        />
      {/await}
    </div>
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
  .burger.on {
    color: var(--accent);
  }
  .diffwrap {
    width: 45%;
    min-width: 340px;
    height: 100vh;
  }
  @media (max-width: 1100px) {
    .diffwrap {
      position: absolute;
      right: 0;
      top: 0;
      width: 90vw;
      z-index: 100;
      box-shadow: -8px 0 30px rgba(0, 0, 0, 0.5);
    }
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
  .toast {
    position: fixed;
    bottom: 52px;
    left: 50%;
    transform: translateX(-50%);
    background: var(--bg-panel);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 7px 14px;
    font-size: 12.5px;
    z-index: 200;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
    max-width: 80vw;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    user-select: none;
  }
  @media (max-width: 900px) {
    /* scope to the session sidebar only — a bare `aside` selector also
       matched the info panel and hid it whenever the sidebar closed */
    .app.nosidebar :global(.sidebar) {
      display: none;
    }
  }
</style>
