// Client for the file-browser routes: GET /oc/fs/{list,file,find,status,diff}.
//
// Both backends answer the same contract (docs/file-browser.md; held by
// pi-web's web/.testbin/fsbrowse-check.mjs and opencode's
// e2e/chatserver-fs-check.py): every request names the SESSION's cwd, and the
// server refuses anything that resolves above its workspace ceiling. So the
// client passes the active tab's cwd on every call — one drawer, N workspaces.
//
// Caches are module-level with a generation counter, matching diffs.ts: a
// reload of the drawer is instant, and `↻` / turn-end bumps the generation
// instead of clearing everything (a listing for a directory nobody is looking at
// is not worth refetching).
//
// A 404 on any /oc/fs/* route is a CAPABILITY PROBE, the same trick as the
// /queue shape: a backend without these routes renders "no file browser here",
// never an error tile and never an empty tree that reads as "the workspace is
// empty".

export interface FsItem {
  name: string
  path: string
  isDirectory: boolean
  size: number | null
  mtime: number
  symlink?: boolean
  /** the link points above the ceiling: show it greyed, every read of it 403s */
  escapes?: boolean
}

export interface FsList {
  root: string
  path: string
  items: FsItem[]
  truncated: boolean
  cap?: number
  error?: string
}

export interface FsFile {
  path: string
  size: number
  type: 'text' | 'binary' | 'image' | 'too_large'
  content?: string
  base64?: string
  mime?: string
  truncated?: boolean
}

export interface FsMatch {
  name: string
  path: string
  isDirectory: boolean
  symlink?: boolean
}

export interface FsDirty {
  path: string
  abs: string
  /** untracked | added | modified | deleted | renamed | copied | typechange | conflicted */
  status: string
  xy?: string
}

export interface FsStatus {
  root: string
  repo: boolean
  toplevel?: string
  head?: string | null
  branch?: string | null
  dirty: FsDirty[]
  /** the repo reaches above the ceiling, so this set is deliberately partial */
  scoped?: boolean
  omitted?: number
  truncated?: boolean
  error?: string
}

export interface FsDiff {
  root: string
  toplevel: string
  path: string
  rel: string
  patch: string
  truncated: boolean
  untracked?: boolean
}

export class FsUnsupported extends Error {}
export class FsDenied extends Error {}
export const isFsDenied = (e: any): boolean => e instanceof FsDenied
export const isFsUnsupported = (e: any): boolean => e instanceof FsUnsupported

let available: boolean | undefined
let gen = 0
const listCache = new Map<string, FsList>()
const statusCache = new Map<string, FsStatus>()

/** false once a backend has 404'd a /oc/fs/* route; undefined = not probed yet */
export function fsAvailable(): boolean {
  return available !== false
}

/** Drop every cached listing/status. `↻`, a workspace change, or a turn ending. */
export function fsBump(): void {
  gen++
}

function k(cwd: string, path = ''): string {
  return `${gen}|${cwd}|${path}`
}

async function get(url: string): Promise<any> {
  const r = await fetch(url, { headers: { 'content-type': 'application/json' } })
  if (r.status === 404 && url.includes('/oc/fs/')) {
    // Only a 404 on the ROUTE means "no such feature". A 404 for a missing
    // file is a real answer, so distinguish them by the payload: the bridge
    // answers file-not-found with `no such file`, the router with `not found`.
    const body = await r.json().catch(() => null)
    if (/not found/i.test(String(body?.error ?? ''))) {
      available = false
      throw new FsUnsupported('this backend has no file browser (/oc/fs/* is not wired)')
    }
    available = available === undefined ? true : available
    throw new Error(String(body?.error ?? 'not found'))
  }
  const body = await r.json().catch(() => null)
  if (!r.ok) {
    if (r.status === 403) throw new FsDenied(String(body?.error ?? 'forbidden'))
    throw new Error(String(body?.error ?? `fs request failed (${r.status})`))
  }
  available = available === undefined ? true : available
  return body
}

export async function fsList(cwd: string, path = '', force = false): Promise<FsList> {
  const key = k(cwd, path)
  if (!force) {
    const hit = listCache.get(key)
    if (hit) return hit
  }
  const q = new URLSearchParams({ cwd })
  if (path) q.set('path', path)
  const res = (await get(`/oc/fs/list?${q}`)) as FsList
  listCache.set(key, res)
  return res
}

export async function fsFile(cwd: string, path: string): Promise<FsFile> {
  const q = new URLSearchParams({ cwd, path })
  return (await get(`/oc/fs/file?${q}`)) as FsFile
}

export async function fsFind(cwd: string, q: string): Promise<{ root: string; matches: FsMatch[]; truncated: boolean }> {
  const p = new URLSearchParams({ cwd, q })
  return await get(`/oc/fs/find?${p}`)
}

export async function fsStatus(cwd: string, force = false): Promise<FsStatus> {
  const key = k(cwd)
  if (!force) {
    const hit = statusCache.get(key)
    if (hit) return hit
  }
  const res = (await get(`/oc/fs/status?${new URLSearchParams({ cwd })}`)) as FsStatus
  statusCache.set(key, res)
  return res
}

export async function fsDiff(cwd: string, path: string): Promise<FsDiff> {
  const q = new URLSearchParams({ cwd, path })
  return (await get(`/oc/fs/diff?${q}`)) as FsDiff
}

/** abs path -> badge kind, for the tree. */
export function dirtyMap(st: FsStatus | null | undefined): Map<string, string> {
  const m = new Map<string, string>()
  for (const d of st?.dirty ?? []) m.set(d.abs, d.status)
  return m
}

/** Roll a dirty set up into collapsed directories, keyed by the DIR's path. */
export function dirtyDirs(st: FsStatus | null | undefined, root: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const d of st?.dirty ?? []) {
    let cur = d.abs
    while (cur && cur.length > root.length && cur !== root) {
      const parent = cur.slice(0, cur.lastIndexOf('/'))
      if (!parent || parent === cur) break
      out.set(parent, (out.get(parent) ?? 0) + 1)
      cur = parent
    }
  }
  return out
}

export function fmtSize(n: number | null | undefined): string {
  if (n == null) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) {
    const kb = n / 1024
    return `${kb >= 100 ? Math.round(kb) : Math.round(kb * 10) / 10} KB`
  }
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

const BADGE: Record<string, string> = {
  untracked: '+',
  added: '+',
  modified: '●',
  deleted: '✗',
  renamed: '↻',
  copied: '↻',
  typechange: '↻',
  conflicted: '!',
}
export function dirtyBadge(status: string | undefined): string {
  return BADGE[String(status ?? '')] ?? '●'
}
