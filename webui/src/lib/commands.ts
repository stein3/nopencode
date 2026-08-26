// Command registry: merges the engine's commands (custom markdown commands +
// skills, which opencode registers as slash commands) with web built-ins that
// mirror the TUI's built-in commands. Both the Ctrl+P palette and the
// composer's inline "/" menu render from here.
import { oc } from './api'
import { RECENT_PAGE, backfill } from './sse'
import {
  tabs,
  dialog,
  toast,
  showThinking,
  showTimestamps,
  selectedModel,
  modelPickerOpen,
  renameTarget,
  settingsOpen,
  cmdVersion,
  type DialogSpec,
} from './stores'
import { refetchNow } from './sse'
import { roleLabel, taskNoticeOf } from './util'

export type CmdSource = 'builtin' | 'command' | 'skill'

export interface Cmd {
  name: string
  description: string
  source: CmdSource
  // true when the command takes free-form arguments after the name
  args?: boolean
  // palette display fields (TUI parity): human title, grouping category,
  // shortcut hint. Engine commands/skills leave them unset.
  title?: string
  category?: string
  keybind?: string
  run: (ctx: CmdCtx, args: string) => void | Promise<void>
}

export interface CmdCtx {
  sessionId: () => string | null
  newChat: () => void
  focusComposer: () => void
  focusSidebar: () => void
}

export const registry = {
  builtins: [] as Cmd[],
  engine: new Map<string, { name: string; description?: string; source: CmdSource }>(),
  pending: null as Promise<void> | null,
  ready: false,

  // single-flight load of engine commands (custom commands + skills)
  load(): Promise<void> {
    if (!this.pending) {
      this.pending = oc
        .commands()
        .then((cmds) => {
          for (const c of cmds ?? []) {
            this.engine.set(c.name, {
              name: c.name,
              description: c.description ?? '',
              source: (c as any).source === 'skill' ? 'skill' : 'command',
            })
          }
          this.ready = true
          cmdVersion.update((n) => n + 1)
        })
        .catch(() => {
          /* engine unreachable — builtins still work */
        })
    }
    return this.pending
  },

  all(): Cmd[] {
    const engineCmds: Cmd[] = [...this.engine.values()].map((c) => ({
      name: c.name,
      description: c.description ?? '',
      source: c.source,
      args: c.source === 'command',
      run: async (ctx, args) => {
        const sid = ctx.sessionId()
        if (!sid) return toast('/' + c.name + ': no active session')
        tabs.patch(sid, { busy: true })
        try {
          await oc.runCommand(sid, c.name, args ? [args] : [])
          ctx.focusComposer()
          if (sid) refetchNow(sid)
        } catch (e: any) {
          tabs.patch(sid, { busy: false })
          toast(`/${c.name} failed: ${e.message ?? e}`)
        }
      },
    }))
    return [...this.builtins, ...engineCmds].sort((a, b) => a.name.localeCompare(b.name))
  },

  find(name: string): Cmd | undefined {
    const n = name.toLowerCase()
    return this.builtins.find((c) => c.name === n) ?? this.all().find((c) => c.name === n)
  },
}

// ---- palette-only suggestions + shared run plumbing ---------------------

// shown under the "Suggested" header when the palette opens with an empty
// query (TUI parity); everything else groups by category below it
export const SUGGESTED = ['new', 'sessions', 'models', 'agents', 'timeline']

// Resolve the active session at COMMAND RUN time — a value computed at
// component mount has no reactive deps and freezes (the frozen-sessionId
// regression). Pending tabs (`pending-*`, not yet realized) resolve to null.
export function resolveActiveSid(): string | null {
  const id = tabs.getActive()
  const t = id ? tabs.snapshot(id) : null
  return t?.pending ? null : id
}

function ctxFor(sid: string | null): CmdCtx {
  return {
    sessionId: () => sid,
    newChat: () => window.dispatchEvent(new CustomEvent('oc:new-chat')),
    focusComposer: () => document.getElementById('composer-input')?.focus(),
    focusSidebar: () => document.dispatchEvent(new CustomEvent('oc:focus-sidebar')),
  }
}

// Run a built-in by name with a freshly-resolved session context. Used by the
// ctrl+p palette, the ctrl+x chord handlers in App.svelte, and anywhere else
// that wants TUI-command semantics without owning the ctx wiring.
export async function runBuiltin(name: string, args = ''): Promise<void> {
  const cmd = registry.builtins.find((c) => c.name === name)
  if (!cmd) return
  try {
    await cmd.run(ctxFor(resolveActiveSid()), args)
  } catch (e) {
    console.error('command failed', e)
  }
}

// ---- helpers ----------------------------------------------------------

function needSession(ctx: CmdCtx): string | null {
  const sid = ctx.sessionId()
  if (!sid) toast('no session yet — send a message first')
  return sid
}

// read the current selected-model store outside of a reactive context
let selModel: { providerID: string; modelID: string } | null = null
selectedModel.subscribe((m) => (selModel = m))
function $selectedModelSnapshot() {
  return selModel
}

function transcriptMarkdown(sid: string): string {
  const t = tabs.snapshot(sid)
  if (!t) return ''
  const lines: string[] = [`# ${t.title || 'session'}\n`]
  for (const m of t.messages) {
    // same label the transcript headers show (agent titlecased / Error /
    // subagent for engine-injected task results)
    const who = roleLabel(m)
    const tn = taskNoticeOf(m)
    lines.push(tn?.desc ? `## ${who} — ${tn.desc}` : `## ${who}`)
    for (const p of m.parts ?? []) {
      if (p.type === 'text' && (p.text ?? '').trim()) lines.push(p.text ?? '')
      else if (p.type === 'tool') lines.push('```\n[' + (p.tool ?? 'tool') + ']\n```\n')
      // composer attachments: acknowledge them so attachment-only messages
      // don't vanish from exports/copies
      else if (p.type === 'file')
        lines.push('[attached: ' + (p.filename ?? p.mime ?? 'file') + ']')
    }
    lines.push('')
  }
  return lines.join('\n')
}

function openDialog(d: DialogSpec) {
  dialog.set(d)
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}

function download(name: string, text: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }))
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 4000)
}

// ---- built-in commands (web counterparts of the TUI's built-ins) --------

registry.builtins = [
  {
    name: 'agents',
    description: 'Switch agent',
    source: 'builtin',
    title: 'Switch agent',
    category: 'Agent',
    keybind: 'ctrl+x a',
    run: async (ctx) => {
      const sid = needSession(ctx)
      if (!sid) return
      let agents: any[] = []
      let current = ''
      try {
        ;[agents, current] = await Promise.all([
          oc.agents(),
          oc.session(sid).then((s: any) => s?.agent ?? '').catch(() => ''),
        ])
      } catch {}
      if (!agents.length) return toast('no agents reported by engine')
      openDialog({
        title: 'Switch agent',
        rows: agents.map((a) => ({
          label: a.name,
          desc: a.mode === 'subagent' ? 'subagent' : a.description ?? '',
          hint: a.name === current ? 'current' : undefined,
          onPick: () =>
            oc
              .setAgent(sid, a.name)
              .then(() => toast(`agent → ${a.name}`))
              .catch((e) => toast(`set agent failed: ${e.message ?? e}`)),
        })),
      })
    },
  },
  {
    name: 'compact',
    description: 'Compact session',
    source: 'builtin',
    title: 'Compact session',
    category: 'Session',
    keybind: 'ctrl+x c',
    run: async (ctx) => {
      const sid = needSession(ctx)
      if (!sid) return
      const model = $selectedModelSnapshot()
      if (!model) return toast('/compact needs a selected model')
      try {
        await oc.summarize(sid, model)
        toast('compacting session…')
      } catch (e: any) {
        toast(`/compact failed: ${e.message ?? e}`)
      }
    },
  },
  {
    name: 'copy',
    description: 'Copy session transcript',
    source: 'builtin',
    title: 'Copy transcript',
    category: 'Session',
    run: async (ctx) => {
      const sid = needSession(ctx)
      if (!sid) return
      await backfill(sid) // transcripts include history the window may not have loaded
      const ok = await copyText(transcriptMarkdown(sid))
      toast(ok ? 'transcript copied to clipboard' : 'clipboard unavailable')
    },
  },
  {
    name: 'copylast',
    description: 'Copy last assistant message',
    source: 'builtin',
    title: 'Copy last assistant message',
    category: 'Session',
    keybind: 'ctrl+x y',
    run: async () => {
      const sid = resolveActiveSid()
      if (!sid) return toast('no session yet — send a message first')
      const t = tabs.snapshot(sid)
      let text = ''
      const msgs = [...(t?.messages ?? [])].reverse()
      for (const m of msgs) {
        if (m.role !== 'assistant') continue
        const part = (m.parts ?? []).find((p) => p.type === 'text' && (p.text ?? '').trim())
        if (part) {
          text = part.text ?? ''
          break
        }
      }
      if (!text) return toast('no assistant message yet')
      const ok = await copyText(text)
      toast(ok ? 'assistant message copied' : 'clipboard unavailable')
    },
  },
  {
    name: 'diff',
    description: 'Show working-tree diff',
    source: 'builtin',
    title: 'Show working-tree diff',
    category: 'Session',
    run: async () => {
      const raw = await oc.diffRaw()
      openDialog({ title: 'git diff', pre: raw || '(no changes)' })
    },
  },
  {
    name: 'export',
    description: 'Export session transcript',
    source: 'builtin',
    title: 'Export transcript',
    category: 'Session',
    keybind: 'ctrl+x x',
    run: async (ctx) => {
      const sid = needSession(ctx)
      if (!sid) return
      await backfill(sid)
      download(`${(tabs.snapshot(sid)?.title ?? 'session').replace(/[^\w-]+/g, '_')}.md`, transcriptMarkdown(sid))
    },
  },
  {
    name: 'fork',
    description: 'Fork session',
    source: 'builtin',
    title: 'Fork session',
    category: 'Session',
    run: async (ctx) => {
      const sid = needSession(ctx)
      if (!sid) return
      try {
        const s = await oc.forkSession(sid)
        // engine titles the fork itself ("… (fork #N)") — don't append again
        tabs.open({ id: s.id, title: s.title ?? 'forked session', messages: [], live: true })
        refetchNow(s.id)
        toast('session forked')
      } catch (e: any) {
        toast(`/fork failed: ${e.message ?? e}`)
      }
    },
  },
  {
    name: 'help',
    description: 'Help',
    source: 'builtin',
    title: 'Help',
    category: 'System',
    run: async () => {
      openDialog({
        title: 'opencode web help',
        pre: [
          'ctrl + p   command palette        /        slash commands in composer',
          'ctrl + t   new chat               ctrl + w close tab',
          'ctrl + k   search history         alt + tab  close tab',
          'alt + 1..9 jump to tab            alt + ←/→ cycle tabs',
          'enter    send                     shift + enter newline',
          'ctrl + x <key> chords: n new · l sessions · b sidebar · m models ·',
          'a agents · g timeline · c compact · x export · y copy last · u undo · s status',
          '',
          'slash commands work inline while typing; arrow keys navigate,',
          'enter/tab selects, esc dismisses the menu.',
        ].join('\n'),
      })
    },
  },
  {
    name: 'mcps',
    description: 'Toggle MCPs',
    source: 'builtin',
    title: 'Toggle MCPs',
    category: 'System',
    run: async () => {
      const mcps = (await oc.mcps()) as Record<string, any>
      const names = Object.keys(mcps ?? {})
      if (!names.length) return toast('no MCP servers configured')
      const connected = (m: any) => m?.status === 'connected' || m?.enabled === true
      openDialog({
        title: 'MCP servers',
        rows: names.map((n) => ({
          label: n,
          desc: `${mcps[n]?.type ?? 'local'} · ${connected(mcps[n]) ? 'connected' : mcps[n]?.status || 'disconnected'}`,
          onPick: () => {
            const on = connected(mcps[n])
            oc.mcpToggle(n, !on)
              .then(() => toast(`${n} ${!on ? 'connect requested' : 'disconnect requested'}`))
              .catch((e) => toast(`toggle failed: ${e.message ?? e}`))
          },
        })),
        note: 'click a server to connect/disconnect',
      })
    },
  },
  {
    name: 'models',
    description: 'Switch model',
    source: 'builtin',
    title: 'Switch model',
    category: 'Model',
    keybind: 'ctrl+x m',
    run: async () => {
      modelPickerOpen.set(true)
    },
  },
  {
    name: 'new',
    description: 'New session',
    source: 'builtin',
    title: 'New session',
    category: 'Session',
    keybind: 'ctrl+t · ctrl+x n',
    run: (ctx) => ctx.newChat(),
  },
  {
    name: 'rename',
    description: 'Rename session',
    source: 'builtin',
    title: 'Rename session',
    category: 'Session',
    run: async (ctx) => {
      const sid = needSession(ctx)
      if (!sid) return
      renameTarget.set({ sid, title: tabs.snapshot(sid)?.title ?? '' })
    },
  },
  {
    name: 'sessions',
    description: 'Switch session',
    source: 'builtin',
    title: 'Switch session',
    category: 'Session',
    keybind: 'ctrl+k · ctrl+x l',
    run: (ctx) => ctx.focusSidebar(),
  },
  {
    name: 'settings',
    description: 'Open settings',
    source: 'builtin',
    title: 'Open settings',
    category: 'System',
    run: () => {
      settingsOpen.set(true)
    },
  },
  {
    name: 'share',
    description: 'Share session link',
    source: 'builtin',
    title: 'Share session link',
    category: 'Session',
    run: async (ctx) => {
      const sid = needSession(ctx)
      if (!sid) return
      try {
        const s = await oc.shareSession(sid)
        const url = (s as any).share?.url
        if (!url) return toast('sharing did not return a URL')
        const ok = await copyText(url)
        toast(ok ? `share URL copied: ${url}` : url)
      } catch (e: any) {
        toast(`/share failed: ${e.message ?? e}`)
      }
    },
  },
  {
    name: 'skills',
    description: 'Skills',
    source: 'builtin',
    title: 'Skills',
    category: 'System',
    run: async () => {
      await registry.load()
      const skills = [...registry.engine.values()].filter((c) => c.source === 'skill')
      let list: any[] = []
      try {
        list = await oc.skills()
      } catch {}
      if (!skills.length && !list.length) return toast('no skills installed')
      openDialog({
        title: 'Skills',
        rows: skills.map((s) => ({
          label: '/' + s.name,
          desc: s.description ?? '',
          onPick: undefined,
        })),
        note: list.length ? `${list.length} skill(s) loaded from disk` : '',
      })
    },
  },
  {
    name: 'status',
    description: 'View status',
    source: 'builtin',
    title: 'View status',
    category: 'System',
    keybind: 'ctrl+x s',
    run: async () => {
      const [pathInfo, provs, mcps] = await Promise.all([
        oc.path() as Promise<{ directory?: string }>,
        oc.providers().catch(() => []),
        oc.mcps() as Promise<Record<string, any>>,
      ])
      const lines = [
        `directory   ${pathInfo?.directory ?? '?'}`,
        `providers   ${provs.length ? provs.map((p: any) => p.id).join(', ') : 'none'}`,
        `mcps        ${Object.keys(mcps ?? {}).length || 'none'}`,
      ]
      openDialog({ title: 'status', pre: lines.join('\n') })
    },
  },
  {
    name: 'thinking',
    description: 'Toggle expanded thinking',
    source: 'builtin',
    title: 'Toggle expanded thinking',
    category: 'View',
    run: () => {
      showThinking.toggle()
      let v = true
      showThinking.subscribe((x) => (v = x))()
      toast(v ? 'thinking blocks expanded' : 'thinking blocks collapsed')
    },
  },
  {
    name: 'timeline',
    description: 'Jump to message',
    source: 'builtin',
    title: 'Jump to message',
    category: 'Session',
    keybind: 'ctrl+x g',
    run: async (ctx) => {
      const sid = needSession(ctx)
      if (!sid) return
      const t = tabs.snapshot(sid)
      const msgs = (t?.messages ?? []).filter((m) =>
        m.parts?.some((p) => p.type === 'text' && (p.text ?? '').trim()),
      )
      if (!msgs.length) return toast('nothing to jump to yet')
      openDialog({
        title: 'Jump to message',
        rows: msgs.reverse().slice(0, 40).map((m) => {
          const text =
            (m.parts ?? []).find((p) => p.type === 'text' && (p.text ?? '').trim())?.text ?? ''
          return {
            label: roleLabel(m) + ' · ' + new Date(
              (m.time?.created ?? 0) < 1e12 ? (m.time?.created ?? 0) * 1000 : m.time?.created ?? 0,
            ).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            desc: text.replace(/\s+/g, ' ').slice(0, 90),
            onPick: () => {
              requestAnimationFrame(() =>
                document.getElementById(`m-${m.id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }),
              )
            },
          }
        }),
      })
    },
  },
  {
    name: 'timestamps',
    description: 'Show timestamps',
    source: 'builtin',
    title: 'Show timestamps',
    category: 'View',
    run: () => {
      showTimestamps.toggle()
      let v = true
      showTimestamps.subscribe((x) => (v = x))()
      toast(v ? 'timestamps shown' : 'timestamps hidden')
    },
  },
  {
    name: 'undo',
    description: 'Undo previous message',
    source: 'builtin',
    title: 'Undo previous message',
    category: 'Session',
    keybind: 'ctrl+x u',
    run: async (ctx) => {
      const sid = needSession(ctx)
      if (!sid) return
      let msgs: any[] = []
      try {
        msgs = await oc.messages(sid, RECENT_PAGE)
      } catch (e: any) {
        return toast(`/undo failed: ${e.message ?? e}`)
      }
      const lastUser = [...msgs]
        .reverse()
        .find((m) => ((m.info ?? m)?.role) === 'user' || m.role === 'user')
      const mid = ((lastUser?.info ?? lastUser)?.id) ?? lastUser?.id
      if (!mid) return toast('nothing to undo')
      try {
        const s = await oc.revertTo(sid, mid)
        tabs.patch(sid, { revert: s.revert ?? null, live: true })
        refetchNow(sid)
        toast('reverted last message')
      } catch (e: any) {
        toast(`/undo failed: ${e.message ?? e}`)
      }
    },
  },
]
