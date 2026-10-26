// Sidebar workspace grouping — extracted from Sidebar.svelte so the ordering
// rules are unit-testable without a browser (e2e/embedded/session-grouping.test.mjs).
//
// The sidebar groups sessions under collapsible project headers keyed by cwd.
// Subagent rows inherit their ROOT's cwd, so a nested tree is never split
// across headers. When no row carries a cwd (a plain opencode engine) or the
// "group by workspace" checkbox is off, the result is ONE anonymous group with
// key '' — the template then renders the old flat, updated-desc list.

export interface WsGroup<T> {
  key: string // cwd path, '' = no workspace known / grouping off
  name: string // header label ('' for the anonymous group: render no header)
  rows: T[]
}

// Minimal shape needed to group: the flattened tree row's depth + its session cwd.
interface Groupable {
  depth: number
  s: { cwd?: string }
}

export function wsLabel(p: string): string {
  if (!p) return 'other'
  const parts = p.split('/').filter(Boolean)
  return parts[parts.length - 1] || p
}

// True when at least one ROOT row knows its workspace — i.e. grouping (or the
// checkbox that controls it) can actually do something.
export function hasWorkspace(rows: Groupable[]): boolean {
  return rows.some((d) => d.depth === 0 && !!d.s.cwd)
}

// `enabled` = the "group by workspace" checkbox. Rows come in sorted
// updated-desc; grouping buckets them by root cwd (order of first appearance),
// while disabling it hands back the single flat time-ordered group.
export function groupRowsByWorkspace<T extends Groupable>(rows: T[], enabled: boolean): WsGroup<T>[] {
  if (!rows.length) return []
  if (!enabled) return [{ key: '', name: '', rows }]

  const out: WsGroup<T>[] = []
  const byKey = new Map<string, WsGroup<T>>()
  let rootCwd = ''
  let any = false
  for (const d of rows) {
    if (d.depth === 0) rootCwd = d.s.cwd || ''
    if (rootCwd) any = true
    let grp = byKey.get(rootCwd)
    if (!grp) {
      grp = { key: rootCwd, name: wsLabel(rootCwd), rows: [] }
      byKey.set(rootCwd, grp)
      out.push(grp)
    }
    grp.rows.push(d)
  }
  return any ? out : [{ key: '', name: '', rows }]
}
