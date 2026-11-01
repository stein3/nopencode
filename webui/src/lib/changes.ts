// The Changes tab: a per-CALL projection of one tab's transcript.
//
// Why this exists next to DiffPane rather than instead of it: the merged
// per-session pane (chatserver `session_changes` + diffs.ts `mergePatches`)
// answers "what does this session look like in total" by concatenating hunks
// and renumbering every header to `@@ -1,N +1,M @@`. That cannot answer "which
// message did what", which is the question a transcript-shaped UI actually
// asks. This module reads the patch OFF the tool part — the same bytes the
// transcript's inline diff block draws from — so the two can never disagree.
//
// No fetch, no endpoint: `tab.messages` is already the root→leaf chain (pi-web
// seeds a resumed child with `leafChain(readJsonl(file))`, the engine prunes at
// a revert), so a reverted edit is simply not in the list. That is free here and
// impossible in the merged view.
//
// What it CANNOT see, stated plainly: an agent that edits through `python3`,
// `sed -i` or `patch` produces no patch on either backend (pi's bash `details`
// are `{truncation, fullOutputPath}` and never carry a patch; opencode's
// `session_changes` filters to edit/write/apply_patch). `shellMutationHint`
// counts those calls so the UI can say "N shell commands may have changed
// files" — a hint, never a diff row. Repo-level truth comes from git
// (`/oc/fs/status`), which is why the Files tab is the one with badges.

export interface ChangeRow {
  msgId: string
  partId: string
  tool: string
  file: string
  /** unified patch text, '' when there is nothing recoverable */
  patch: string
  /**
   * 'patch'   — a real patch from the tool (pi edit, opencode edit/apply_patch)
   * 'adds'    — synthesized all-adds (a create: `write` with content)
   * 'unknown' — the file changed but NO before-image exists anywhere
   */
  kind: 'patch' | 'adds' | 'unknown'
  additions: number
  deletions: number
  at?: number
  status?: string
}

// pi: edit/write (+ extension tools). opencode: edit/write/apply_patch/multiedit.
// A NAME SET, not a substring test: a bare /write/ matches `todowrite`, which
// changes no file, and matching it would draw a fake row in the Changes tab.
const EDIT_TOOLS = new Set([
  'edit', 'write', 'apply_patch', 'patch', 'multiedit', 'multi_edit', 'edit_file',
  'write_file', 'create_file', 'str_replace', 'search_replace', 'notebook_edit',
])
// The shell commands that plausibly write. A hint, so a false positive is
// tolerable; a false NEGATIVE is the bug worth caring about.
const WRITEISH =
  /(>>?(?!&)\s*\S|\btee\b|\bsed\s+(--in-place|-i)\b|\bperl\s+-p[iI]?\b|\bpython[0-9.]*\b|\bpatch\b|\bapply_patch\b|\btruncate\b|\bmv\b|\brm\b|\bdd\b|\bmake\b|\bcargo\b|\bnpm\s+(install|i|ci)\b|\bpip\s+install\b|git\s+(add|apply|commit|checkout|restore|reset|clean)\b)/i
const SHELL_TOOL = /^bash$|^shell$|^exec$|^command$|^terminal$/i

export function isEditTool(tool: unknown): boolean {
  const s = String(tool ?? '').trim().toLowerCase()
  if (EDIT_TOOLS.has(s)) return true
  // namespaced/prefixed forms: `mcp__x__edit_file`, `str_replace_editor`
  return /(^|_)(edit|write|apply_patch)(_|$)/.test(s)
}

/**
 * The transcript's own rule (Transcript.svelte `patchTextOf`), copied so the
 * inline block and this tab agree by construction: filediff.patch, then
 * metadata.diff, then all-adds synthesized from the tool's own content arg.
 */
export function patchTextOf(p: any): string {
  const st = p?.state ?? {}
  const md = st.metadata ?? {}
  const patch =
    (typeof md.filediff?.patch === 'string' && md.filediff.patch) ||
    (typeof md.patch === 'string' && md.patch) ||
    (typeof md.filediff?.diff === 'string' && md.filediff.diff) ||
    (typeof md.diff === 'string' && md.diff) ||
    ''
  if (patch) return patch
  const c = st.input?.content ?? st.input?.newString
  return typeof c === 'string' && c.trim() ? c.replace(/\n$/, '').split('\n').map((l) => '+' + l).join('\n') : ''
}

function fileOf(p: any): string {
  const st = p?.state ?? {}
  const md = st.metadata ?? {}
  return String(
    md.filediff?.file ?? st.input?.filePath ?? st.input?.file_path ?? st.input?.path ?? st.input?.file ??
      (typeof md.file === 'string' ? md.file : '') ?? '',
  )
}

const count = (patch: string, mark: '+' | '-') =>
  patch.split('\n').filter((l) => l.startsWith(mark) && !(mark === '+' && l.startsWith('+++')) && !(mark === '-' && l.startsWith('---'))).length

/**
 * Rows in transcript order, one per editing tool call. The tab's `messages` are
 * the active chain, so this is already revert-aware.
 */
export function sessionChanges(tab: { messages?: any[] } | undefined): ChangeRow[] {
  const out: ChangeRow[] = []
  for (const m of tab?.messages ?? []) {
    for (const p of m?.parts ?? []) {
      if (p?.type !== 'tool' || !isEditTool(p.tool)) continue
      const status = String(p.state?.status ?? '')
      // a running call has no result yet; an errored one changed nothing
      if (status && status !== 'completed') continue
      const patch = patchTextOf(p)
      const file = fileOf(p)
      if (!patch && !file) continue
      out.push({
        msgId: String(m.id ?? ''),
        partId: String(p.id ?? p.callID ?? ''),
        tool: String(p.tool ?? ''),
        file,
        patch,
        kind: patch ? (/^(\+\+\+|---|@@|diff )/m.test(patch) ? 'patch' : 'adds') : 'unknown',
        additions: count(patch, '+'),
        deletions: count(patch, '-'),
        at: Number(p.state?.time?.end ?? p.state?.time?.start ?? m?.time?.created ?? 0) || undefined,
        status,
      })
    }
  }
  return out
}

/** Paths the session touched, as the tools spelled them (see `isTouched`). */
export function touchedFiles(rows: ChangeRow[]): Set<string> {
  const s = new Set<string>()
  for (const r of rows) if (r.file) s.add(r.file)
  return s
}

/**
 * Transcript paths are absolute under the worktree while a browsed tree hands
 * out paths under ITS root, so matching is by trailing segments — never by
 * string equality alone.
 */
export function isTouched(touched: Set<string>, absPath: string): boolean {
  if (!touched.size) return false
  const a = String(absPath).replace(/\\/g, '/').replace(/\/+$/, '')
  for (const t of touched) {
    const b = String(t).replace(/\\/g, '/')
    if (!b) continue
    if (a === b) return true
    if (a.endsWith('/' + b.replace(/^\/+/, ''))) return true
    if (b.endsWith('/' + a.replace(/^\/+/, ''))) return true
  }
  return false
}

/**
 * How many shell calls in this tab could have changed files without any tool
 * being able to say so. Counted, not diffed — rendering one of these as a
 * change row would be a lie.
 */
export function shellMutationHint(tab: { messages?: any[] } | undefined): number {
  let n = 0
  for (const m of tab?.messages ?? []) {
    for (const p of m?.parts ?? []) {
      if (p?.type !== 'tool' || !SHELL_TOOL.test(String(p.tool ?? ''))) continue
      const cmd = String(p.state?.input?.command ?? p.state?.title ?? '')
      if (cmd && WRITEISH.test(cmd)) n++
    }
  }
  return n
}
