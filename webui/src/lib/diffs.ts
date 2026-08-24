// Unified-diff parsing + fetching for the DiffPane.
// Sources: session mode -> chatserver /api/history/session/{id}/changes
//          (per-session edit/write/apply_patch ops reconstructed into patches)
//          worktree mode -> engine /vcs/diff?mode=git  [{file, patch}]
// All results are cached at module level so closing/reopening the pane
// (or switching tabs) is instant; the pane's ↻ button forces a refetch.

export interface DiffFile {
  file: string
  patch: string
}

export interface ParsedDiff {
  original: string
  modified: string
  additions: number
  deletions: number
}

interface ChangeOp {
  k: 'edit' | 'write' | 'patch' | 'delete'
  t?: number
  patch?: string
}

const diffCache = new Map<string, { files: DiffFile[]; source: string }>()
const parseCache = new Map<
  string,
  { patch: string; parsed: ParsedDiff; parsedInline: ParsedDiff }
>()
const fullCache = new Map<string, { patch: string; original: string; modified: string }>()

const WORKTREE_PREFIX = '/workspace/'

// Transcript paths are absolute under the shared worktree; vcs/diff returns
// worktree-relative ones. Normalize both so cache/content-fetch keys match.
function relPath(p: string): string {
  return p.startsWith(WORKTREE_PREFIX) ? p.slice(WORKTREE_PREFIX.length) : p.replace(/^\//, '')
}

// A session touches a file through many sequential ops; concatenate their
// hunks into ONE canonical multi-hunk patch. Never concat raw patch texts:
// parsers stop at the first foreign header, and applyPatchReverse would then
// only undo the first op.
export function mergePatches(ops: ChangeOp[] | undefined): string {
  const hunks: string[][] = []
  let cur: string[] | null = null
  const flush = () => {
    if (cur?.length) hunks.push(cur)
    cur = null
  }
  for (const op of ops ?? []) {
    flush() // patches never span ops
    for (const line of (op.patch ?? '').split('\n')) {
      if (line.startsWith('@@')) {
        flush()
        cur = []
      } else if (cur) {
        if (line.startsWith('\\')) continue
        if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line === '') {
          cur.push(line)
        } else {
          flush() // ran into a foreign file header inside the patch
        }
      }
    }
  }
  flush()
  return hunks
    .map((h) => {
      const oldN = h.filter((l) => !l.startsWith('+')).length
      const newN = h.filter((l) => !l.startsWith('-')).length
      return `@@ -1,${oldN} +1,${newN} @@\n${h.join('\n')}`
    })
    .join('\n')
}

function toDiffFiles(payload: { files?: { file: string; ops: ChangeOp[] }[] }): DiffFile[] {
  return (payload.files ?? [])
    .map((f) => ({ file: relPath(f.file), patch: mergePatches(f.ops) }))
    .filter((f) => f.patch.length > 0) // pure overwrites/deletes have no recoverable pre-image
}

function key(sessionId?: string): string {
  return sessionId || 'worktree'
}

export function cachedDiffs(sessionId?: string): { files: DiffFile[]; source: string } | undefined {
  return diffCache.get(key(sessionId))
}

export async function fetchDiffs(
  sessionId: string | undefined,
  force = false,
  worktree = false,
): Promise<{ files: DiffFile[]; source: string }> {
  const k = key(worktree ? undefined : sessionId)
  if (!force) {
    const hit = diffCache.get(k)
    if (hit) return hit
  }
  if (!worktree && sessionId) {
    const r = await fetch(`/api/history/session/${sessionId}/changes`)
    if (!r.ok) throw new Error(`session changes fetch failed (${r.status})`)
    const d = await r.json()
    const res = { files: toDiffFiles(d), source: 'this session' }
    diffCache.set(k, res)
    return res
  }
  const r = await fetch('/oc/vcs/diff?mode=git')
  if (!r.ok) throw new Error(`diff fetch failed: ${r.status}`)
  const d = await r.json()
  if (!Array.isArray(d)) throw new Error('unexpected diff payload')
  const res = {
    files: d.map((f: DiffFile) => ({ file: relPath(f.file), patch: f.patch })),
    source: 'worktree (uncommitted)',
  }
  diffCache.set(k, res)
  return res
}

// Parse a per-file patch into display pairs (memoized per cache key).
// `parsed`  — row-aligned, for side-by-side rendering
// `parsedInline` — unpadded, for inline (single-column) rendering
export function parsedFor(sessionId: string | undefined, f: DiffFile): ParsedDiff {
  return parseBothFor(sessionId, f).parsed
}

export function inlineParsedFor(sessionId: string | undefined, f: DiffFile): ParsedDiff {
  return parseBothFor(sessionId, f).parsedInline
}

function parseBothFor(
  sessionId: string | undefined,
  f: DiffFile,
): { parsed: ParsedDiff; parsedInline: ParsedDiff } {
  const k = `${key(sessionId)}:${f.file}`
  const hit = parseCache.get(k)
  if (hit && hit.patch === f.patch) return hit
  const entry = { patch: f.patch, parsed: parsePatch(f.patch), parsedInline: parsePatchInline(f.patch) }
  parseCache.set(k, entry)
  return entry
}

// Current file contents straight from the engine workspace.
export async function fetchFileContent(path: string): Promise<string> {
  const r = await fetch(`/oc/file/content?path=${encodeURIComponent(path)}`)
  if (!r.ok) throw new Error(`content fetch failed (${r.status})`)
  const d = await r.json()
  if (d.type !== 'text' || typeof d.content !== 'string') throw new Error('binary/unsupported file')
  return d.content
}

// Whole-file pair: modified = live content, original = live content with the
// patch reverse-applied. Memoized and invalidated when the patch changes.
export async function fullPairFor(
  sessionId: string | undefined,
  f: DiffFile,
): Promise<{ original: string; modified: string }> {
  const k = `${key(sessionId)}:${f.file}`
  const hit = fullCache.get(k)
  if (hit && hit.patch === f.patch) return { original: hit.original, modified: hit.modified }
  const modified = await fetchFileContent(f.file)
  const original = applyPatchReverse(modified, f.patch)
  fullCache.set(k, { patch: f.patch, original, modified })
  return { original, modified }
}

interface Row {
  t: '+' | '-' | ' '
  s: string
}

// Collect tagged hunk rows from one patch (a foreign file header terminates it).
function parseRows(patch: string): Row[] {
  const rows: Row[] = []
  let inHunk = false
  for (const line of patch.split('\n')) {
    if (!inHunk) {
      if (line.startsWith('@@')) inHunk = true
      continue // skip diff --git / index / --- / +++ headers
    }
    if (line.startsWith('@@')) continue // next hunk
    if (line.startsWith('\\')) continue // "\ No newline at end of file"
    if (line.startsWith('+')) rows.push({ t: '+', s: line.slice(1) })
    else if (line.startsWith('-')) rows.push({ t: '-', s: line.slice(1) })
    else if (line.startsWith(' ') || line === '') {
      rows.push({ t: ' ', s: line.startsWith(' ') ? line.slice(1) : '' })
    } else {
      inHunk = false // ran into a new file's header
    }
  }
  return rows
}

const statsOf = (rows: Row[]) => ({
  additions: rows.filter((r) => r.t === '+').length,
  deletions: rows.filter((r) => r.t === '-').length,
})

// Pair for SIDE-BY-SIDE view: each changed row pads the opposite side with a
// blank so context lines stay row-aligned across the two editors.
export function parsePatch(patch: string): ParsedDiff {
  const rows = parseRows(patch)
  const orig = rows.map((r) => (r.t === '+' ? '' : r.s))
  const mod = rows.map((r) => (r.t === '-' ? '' : r.s))
  return { original: orig.join('\n'), modified: mod.join('\n'), ...statsOf(rows) }
}

// Pair for INLINE (single-column) view: no placeholder padding — padding is
// meaningless there and would surface as stray blank lines everywhere.
export function parsePatchInline(patch: string): ParsedDiff {
  const rows = parseRows(patch)
  const orig = rows.filter((r) => r.t !== '+').map((r) => r.s)
  const mod = rows.filter((r) => r.t !== '-').map((r) => r.s)
  return { original: orig.join('\n'), modified: mod.join('\n'), ...statsOf(rows) }
}

// All positions where `needle` occurs in `hay` (empty needle never matches).
function matchAll(hay: string[], needle: string[]): number[] {
  if (!needle.length || needle.every((l) => l === '')) return []
  const hits: number[] = []
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer
    }
    hits.push(i)
    i += needle.length - 1 // no overlap interest; speeds up big blocks
  }
  return hits
}

// Reconstruct pre-change content by undoing each hunk against `modified`.
// Bottom-up application keeps earlier line offsets valid. When a hunk's
// context matches several places, pick the hit nearest the previous hunk's
// position (edits cluster); unresolvable hunks are skipped gracefully.
export function applyPatchReverse(modified: string, patch: string): string {
  const hunks: Row[][] = []
  let cur: Row[] | null = null
  const flush = () => {
    if (cur?.length) hunks.push(cur)
    cur = null
  }
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      flush()
      cur = []
    } else if (cur) {
      if (line.startsWith('\\')) continue
      if (line.startsWith('+')) cur.push({ t: '+', s: line.slice(1) })
      else if (line.startsWith('-')) cur.push({ t: '-', s: line.slice(1) })
      else if (line.startsWith(' ') || line === '') {
        cur.push({ t: ' ', s: line.startsWith(' ') ? line.slice(1) : '' })
      }
      // anything else = next file's header; stop collecting this patch
      else {
        flush()
        break
      }
    }
  }
  flush()

  const lines = modified.split('\n')
  // Seed "previous position" at the file bottom: session edits accumulate
  // toward EOF, so the chronologically-last hunk (processed first) should
  // anchor as low as possible; continuity then guides earlier hunks upward.
  let prev = lines.length
  for (let i = hunks.length - 1; i >= 0; i--) {
    const rows = hunks[i]
    const newSide = rows.filter((r) => r.t !== '-').map((r) => r.s)
    let hits = matchAll(lines, newSide)
    if (!hits.length) {
      // Hunk no longer anchors exactly (V4A sections carry model-approximated
      // context; a later write may have replaced the region): fall back to
      // un-applying its longest contiguous added run.
      let best = -1
      let bestLen = 0
      let runStart = -1
      for (let j = 0; j <= rows.length; j++) {
        const isAdd = j < rows.length && rows[j].t === '+' && rows[j].s !== ''
        if (isAdd) {
          if (runStart < 0) runStart = j
        } else if (runStart >= 0) {
          if (j - runStart > bestLen) {
            bestLen = j - runStart
            best = runStart
          }
          runStart = -1
        }
      }
      if (best >= 0) {
        const block = rows.slice(best, best + bestLen).map((r) => r.s).filter((l) => l !== '')
        hits = matchAll(lines, block)
        if (hits.length) {
          const at = nearest(hits, prev)
          lines.splice(at, block.length)
          prev = at
        }
      }
      continue
    }
    const at = nearest(hits, prev)
    // Undo = keep context/deleted rows, DROP added rows entirely (never blank
    // them — additions must vanish from the reconstructed pre-image).
    const replacement = rows.filter((r) => r.t !== '+').map((r) => r.s)
    lines.splice(at, newSide.length, ...replacement)
    prev = at
  }
  return lines.join('\n')
}

function nearest(hits: number[], prefer: number): number {
  let bestHit = hits[0]
  for (const h of hits) {
    if (Math.abs(h - prefer) < Math.abs(bestHit - prefer)) bestHit = h
  }
  return bestHit
}
