<script lang="ts">
  import { onMount } from 'svelte'
  import Sidebar from './components/Sidebar.svelte'
  import TabsBar from './components/Tabs.svelte'
  import Transcript from './components/Transcript.svelte'
  import Composer from './components/Composer.svelte'
  import QuestionBanner from './components/QuestionBanner.svelte'
  import Footer from './components/Footer.svelte'
  import { hist, oc } from './lib/api'
  import { tabs, permissions, sidebarOpen, selectedModel, paletteOpen, infoOpen, toggleInfo, toastMsg, patchMetrics, clearSessionUnread, loadOpenTabs, rekeySessionAgent, rekeySessionModel, modelPickerOpen, theme, markSessionListDirty, type Tab } from './lib/stores'
  import CommandPalette from './components/CommandPalette.svelte'
  import CommandDialog from './components/CommandDialog.svelte'
  import RenameDialog from './components/RenameDialog.svelte'
  import WhichKey from './components/WhichKey.svelte'
  import Settings from './components/Settings.svelte'
  import ImageLightbox from './components/ImageLightbox.svelte'
  import ComposerModelPicker from './components/ComposerModelPicker.svelte'
  import InfoPanel from './components/InfoPanel.svelte'
  import { startEvents, applyMessages, backfill, loadOlder, RECENT_PAGE, JUMP_CAP } from './lib/sse'
  import { cancelRetry } from './lib/retries'
  import { answerPermission, refreshPermissions } from './lib/permissions'
  import { initHotkeys } from './lib/hotkeys'
  import { runBuiltin } from './lib/commands'
  import { installVisualViewportFix } from './lib/visualViewport'
  import { focusMode, initKbdLock, enableFocusMode, disableFocusMode } from './lib/kbdlock'
  import { msgModel } from './lib/util'

  let composers: Record<string, Composer> = {}
  let diffOpen = false

  // apply theme to <html> on store change
  $: document.documentElement.setAttribute('data-theme', $theme)

  // ---- pane dormancy -------------------------------------------------------
  // Transcript DOM is the app's heaviest asset (~20–70 nodes/message), and
  // hidden panes keep every row mounted forever. Tabs outside the active one +
  // the PANE_KEEP most-recently-active render a placeholder instead: their
  // message data stays hot on the Tab in the stores, so re-activation renders
  // instantly from memory (no refetch, no scroll restore needed — activation
  // force-pins to bottom anyway).
  const PANE_KEEP = 5
  let recentOrder: string[] = [] // most-recent-first
  $: noteActivation($active)
  function noteActivation(id: string | null) {
    if (!id || recentOrder[0] === id) return
    recentOrder = [id, ...recentOrder.filter((x) => x !== id)].slice(0, 32)
  }
  $: dormantIds = computeDormant($tabs, $active, recentOrder)
  function computeDormant(list: Tab[], activeId: string | null, order: string[]): Set<string> {
    const keep = new Set(order.slice(0, PANE_KEEP))
    if (activeId) keep.add(activeId)
    const out = new Set<string>()
    for (const t of list) if (!keep.has(t.id)) out.add(t.id)
    return out
  }

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

  // Persisted turn-failure tiles: fetch once per tab open. The errorsFetched
  // guard also keeps the onSent refetch path (openLive 150ms after each send)
  // from re-fetching rows it already has.
  function loadErrors(id: string) {
    if (tabs.snapshot(id)?.errorsFetched) return
    tabs.patch(id, { errorsFetched: true })
    hist.sessionErrors(id).then((errs) => {
      if (!errs.length) return
      const local = tabs.snapshot(id)?.errors ?? []
      const merged = [...local]
      for (const e of errs)
        if (!merged.some((x) => x.message === e.message)) merged.push(e)
      if (merged.length !== local.length) tabs.patch(id, { errors: merged })
    })
  }

  async function openHistory(id: string, anchor?: string, allowLive = true, silent = false, activate = true) {
    // Prefer the engine-backed (live) view so the info panel can populate
    // cost/tokens/todos; fall back to the pure-history snapshot only when the
    // engine doesn't know the session or is down.
    let ok = false
    if (allowLive) {
      try {
        const s = await oc.session(id)
        openTab({ id, title: s?.title || id.slice(0, 14), messages: [], live: true })
        await openLive(id, s?.title, activate, silent)
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
            agent: m.agent,
            time: { created: m.time },
            parts: m.parts,
            error: (m as any).error,
            // chatserver flattens nested model.modelID server-side; msgModel
            // keeps this path uniform if the projection ever changes shape
            ...msgModel(m),
          })),
        })
        loadErrors(id)
      } catch (e: any) {
        if (!silent) alert(`open failed: ${e.message}`)
        return false
      }
    }
    if (anchor) {
      // search hits can point into history the initial window didn't load;
      // the transcript owns the actual scroll (it knows when backfilled rows
      // have landed and follow()-snapping must stand down)
      const snap = tabs.snapshot(id)
      if (snap?.live && !snap.messages.some((m) => m.id === anchor)) {
        await backfill(id, JUMP_CAP)
        if (!tabs.snapshot(id)?.messages.some((m) => m.id === anchor)) await backfill(id)
      }
      tabs.patch(id, { jumpTo: anchor })
    }
    return true
  }

  async function openLive(id: string, title?: string, activate = true, silent = false) {
    try {
      const [msgs, s] = await Promise.all([
        oc.messages(id, RECENT_PAGE),
        oc.session(id).catch(() => null as any),
      ])
      applyMessages(id, msgs, msgs.length < RECENT_PAGE)
      tabs.patch(id, { live: true, revert: s?.revert ?? null })
      loadErrors(id)
      // session cost is engine-maintained; the messages payload can't derive it
      if (typeof s?.cost === 'number') patchMetrics(id, { cost: s.cost })
      // NOTE: no selectedModel sync from the session here — this runs on every
      // tab open and right after each send, so echoing session.model back into
      // the picker clobbered fresh user picks (the "model didn't stick" bug).
      // The picker is the single source of truth for the next prompt's model.
    } catch {
      // not an engine session (pure history) — fall back to history view;
      // allowLive=false prevents openHistory ↔ openLive recursion
      return openHistory(id, undefined, false, silent, activate)
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
    // born with the picker's model — otherwise the session inherits the engine
    // config default and the first turn ignores the dropdown selection
    const m = $selectedModel
    const s = await oc.createSession(undefined, m ?? undefined)
    tabs.rekey(tabId, { ...t, id: s.id, pending: false })
    // an agent picked on the pending tab follows the session to its real id
    rekeySessionAgent(tabId, s.id)
    rekeySessionModel(tabId, s.id)
    // sidebar won't see the new session until the 60 s poll — bump the dirty
    // signal so it reloads immediately
    markSessionListDirty()
    return s.id
  }

  function closeTab(id: string) {
    cancelRetry(id) // no orphan retry timers for closed sessions
    tabs.close(id)
  }

  onMount(() => {
    startEvents()
    installVisualViewportFix()
    window.addEventListener('oc:new-chat', onNewChatEvent)
    document.addEventListener('oc:focus-sidebar', onFocusSidebar)
    ;(async () => {
      // restore previously-open session tabs (issue #1); fall back to the old
      // "open most recent root session" behavior when nothing was stored or
      // every stored id failed to open (deleted sessions, engine+history down)
      const saved = loadOpenTabs()
      if (saved && saved.ids.length) {
        // Pre-create placeholder tabs from localStorage so the tab bar
        // renders instantly — content loads in the background.
        for (const id of saved.ids) {
          if (!tabs.isopen(id)) {
            tabs.open({ id, title: id.slice(0, 14), messages: [], live: false }, false)
          }
        }
        if (saved.active && tabs.isopen(saved.active)) tabs.setActive(saved.active)
        // Fetch all tab content in parallel — each openHistory patches
        // the existing placeholder with real title/messages/status.
        // Tabs that fail to open (deleted session, engine+history down)
        // get their placeholder removed.
        await Promise.allSettled(
          saved.ids.map(async (id) => {
            const ok = await openHistory(id, undefined, true, true, false)
            if (!ok) tabs.close(id)
          }),
        )
        tabs.persist() // prune ids that failed to open from the stored list
        return
      }
      try {
        const all = await hist.sessions()
        const latest = all.filter((s) => !s.parent).sort((a, b) => b.updated - a.updated)[0]
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
      // ctrl+x leader chords (TUI parity); which-key strip shows the map
      chords: {
        n: newChat,
        l: () => document.getElementById('sidebar-search')?.focus(),
        b: () => sidebarOpen.update((v) => !v),
        m: () => modelPickerOpen.set(true),
        a: () => runBuiltin('agents'),
        g: () => runBuiltin('timeline'),
        c: () => runBuiltin('compact'),
        x: () => runBuiltin('export'),
        y: () => runBuiltin('copylast'),
        u: () => runBuiltin('undo'),
        s: () => runBuiltin('status'),
      },
    })
    const removeKbdLock = initKbdLock()
    window.addEventListener('touchstart', swipeStart, { passive: true })
    window.addEventListener('touchmove', swipeMove, { passive: true })
    window.addEventListener('touchend', swipeEnd)
    window.addEventListener('touchcancel', swipeEnd)
    return () => {
      removeHotkeys()
      removeKbdLock()
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
  // viewing a session clears its done/unread sidebar light (covers tab clicks,
  // hotkey cycling, new chats — any path that changes the active tab)
  $: if ($active) clearSessionUnread($active)

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

  // ---- file drag & drop over the tab pane ---------------------------------
  // The pane forwards dropped files to ITS composer (one instance per tab).
  // Only drags whose types include 'Files' participate: text/URL drags keep
  // their native behavior untouched. dragover must preventDefault for the
  // drop event to fire at all.
  let dragPane = ''

  function dragHasFiles(e: DragEvent): boolean {
    return Array.from(e.dataTransfer?.types ?? []).includes('Files')
  }
  function paneDragEnter(e: DragEvent, id: string) {
    if (!dragHasFiles(e)) return
    e.preventDefault()
    dragPane = id
  }
  function paneDragOver(e: DragEvent, id: string) {
    if (!dragHasFiles(e)) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    dragPane = id
  }
  function paneDragLeave(e: DragEvent, id: string) {
    if (dragPane !== id) return
    // crossing child elements fires leave+enter pairs — only clear when the
    // pointer truly left the pane (relatedTarget null = left the window)
    const to = e.relatedTarget as Node | null
    if (to && (e.currentTarget as HTMLElement).contains(to)) return
    dragPane = ''
  }
  function paneDrop(e: DragEvent, id: string) {
    e.preventDefault()
    dragPane = ''
    if (!dragHasFiles(e)) return
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (files.length) void composers[id]?.attachFiles(files)
  }
  // A file drop that misses every pane would otherwise navigate the browser
  // to the dropped file — neutralize those globally.
  function winDragGuard(e: DragEvent) {
    if (dragHasFiles(e)) e.preventDefault()
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

<svelte:window on:dragover={winDragGuard} on:drop={winDragGuard} />

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
      <button
        class="burger"
        class:pressed={$focusMode.on}
        title="Focus mode: fullscreen + capture Ctrl+W"
        on:click={() => ($focusMode.on ? disableFocusMode() : enableFocusMode())}
      >
        ⌨
      </button>
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
            <span class="ptitle" title={p.title || p.permission || p.id}>
              <b>{p.permission ?? 'permission'}</b>{#if p.title}<span class="pdetail">{p.title}</span>{/if}
            </span>
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
      <div
        class="tabpane"
        style:display={$active === t.id ? 'flex' : 'none'}
        on:dragenter={(e) => paneDragEnter(e, t.id)}
        on:dragover={(e) => paneDragOver(e, t.id)}
        on:dragleave={(e) => paneDragLeave(e, t.id)}
        on:drop={(e) => paneDrop(e, t.id)}
      >
        <Transcript
          tab={t}
          active={t.id === $active}
          dormant={dormantIds.has(t.id)}
          onLoadOlder={() => loadOlder(t.id)}
          onReverted={(text) => composers[t.id]?.prefill(text)}
        />
        {#if $permissions.some((p) => p.sessionID === t.id)}
          <div class="perm-inline">
            {#each $permissions.filter((p) => p.sessionID === t.id) as p (p.id)}
              <div class="perm-row">
                <span class="ptitle" title={p.title || p.permission || p.id}>
                  <b>{p.permission ?? 'permission'}</b>{#if p.title}<span class="pdetail">{p.title}</span>{/if}
                </span>
                <button class="ok" on:click={() => answerPermission(p, 'once')}>once</button>
                <button class="always" on:click={() => answerPermission(p, 'always')}>always</button>
                <button class="deny" on:click={() => answerPermission(p, 'reject')}>deny</button>
              </div>
            {/each}
          </div>
        {/if}
        <QuestionBanner sessionId={t.id} />
        <ComposerModelPicker sid={t.id} />
        <Composer
          bind:this={composers[t.id]}
          tab={t}
          onSent={onSent}
          realize={() => realizeSession(t.id)}
          dropActive={dragPane === t.id}
        />
        <Footer tab={t} />
      </div>
    {:else}
      <div class="notabs">Ctrl+T to start a chat · pick a session from the sidebar</div>
    {/each}
    <CommandPalette onDone={() => focusActiveComposer()} />
    <CommandDialog />
    <RenameDialog />
    <WhichKey />
    <Settings />
    <ImageLightbox />
    {#if $toastMsg}
      <div class="toast">{$toastMsg}</div>
    {/if}
  </main>
  {#if $infoOpen}
    <InfoPanel
      tab={$tabs.find((t) => t.id === $active) ?? null}
      onOpen={(id) => openHistory(id)}
    />
  {/if}
  {#if diffOpen}
    <div class="diffwrap">
      {#await import('./components/DiffPane.svelte') then DiffPane}
        <DiffPane.default
          sessionId={tabs.snapshot(tabs.getActive())?.pending ? '' : tabs.getActive()}
          visible={diffOpen}
          onClose={() => (diffOpen = false)}
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
  /* dvh + --vvh (visualViewport.ts): keyboard-aware shell height where the
     soft keyboard overlays instead of resizing the layout. Base 100vh stays
     for engines without dvh — a var() fallback would be dropped entirely
     there (invalid at computed-value time), hence the @supports override. */
  @supports (height: 100dvh) {
    .app {
      height: var(--vvh, 100dvh);
    }
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
  /* focus-mode toggle pressed state — same accent treatment as .burger.on */
  .burger.pressed {
    color: var(--accent);
  }
  .diffwrap {
    width: 45%;
    min-width: 340px;
    height: 100vh;
  }
  @supports (height: 100dvh) {
    .diffwrap {
      height: var(--vvh, 100dvh);
    }
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
    max-width: 420px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ptitle b {
    font-weight: 600;
    color: var(--warn);
  }
  .pdetail {
    margin-left: 6px;
    opacity: 0.85;
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
  .perm-inline {
    flex: none;
    margin: 0 auto;
    width: 100%;
    max-width: 860px;
    padding: 0 16px 6px;
  }
  .perm-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding: 7px 10px;
    border: 1px solid var(--warn);
    border-left-width: 3px;
    border-radius: 6px;
    background: rgba(255, 170, 0, 0.07);
    font-size: 12.5px;
  }
  .perm-row .ptitle {
    max-width: none;
    flex: 1;
    min-width: 0;
    font-size: inherit;
    padding: 1px 4px;
    border-color: transparent;
    background: transparent;
    white-space: normal;
  }
  .perm-row button {
    font-size: 11.5px;
    padding: 3px 12px;
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
