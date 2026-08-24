// Unified-diff parsing + fetching for the DiffPane.
// Data source: engine /vcs/diff?mode=git  -> [{file, patch}]
//              /session/{id}/diff has the same shape but is often empty;
//              we try it first and fall back to the worktree diff.
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

const diffCache = new Map<string, { files: DiffFile[]; source: string }>()
const parseCache = new Map<string, { patch: string; parsed: ParsedDiff }>()
const fullCache = new Map<string, { patch: string; original: string; modified: string }>()

function key(sessionId?: string): string {
  return sessionId || 'worktree'
}

export function cachedDiffs(sessionId?: string): { files: DiffFile[]; source: string } | undefined {
  return diffCache.get(key(sessionId))
}

export async function fetchDiffs(
  sessionId?: string,
  force = false,
): Promise<{ files: DiffFile[]; source: string }> {
  const k = key(sessionId)
  if (!force) {
    const hit = diffCache.get(k)
    if (hit) return hit
  }
  if (sessionId && !force) {
    try {
      const r = await fetch(`/oc/session/${sessionId}/diff`)
      if (r.ok) {
        const d = await r.json()
        if (Array.isArray(d) && d.length) {
          const res = { files: d, source: 'session' }
          diffCache.set(k, res)
          return res
        }
      }
    } catch {
      /* fall through */
    }
  }
  const r = await fetch('/oc/vcs/diff?mode=git')
  if (!r.ok) throw new Error(`diff fetch failed: ${r.status}`)
  const d = await r.json()
  if (!Array.isArray(d)) throw new Error('unexpected diff payload')
  const res = { files: d, source: 'worktree (uncommitted)' }
  diffCache.set(k, res)
  return res
}

// Parse a per-file unified patch into two full texts (memoized per cache key).
export function parsedFor(sessionId: string | undefined, f: DiffFile): ParsedDiff {
  const k = `${key(sessionId)}:${f.file}`
  const hit = parseCache.get(k)
  if (hit && hit.patch === f.patch) return hit.parsed
  const parsed = parsePatch(f.patch)
  parseCache.set(k, { patch: f.patch, parsed })
  return parsed
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

// Walk a per-file unified patch and synthesize the two texts so Monaco can
// render a real side-by-side diff without fetching git blobs.
export function parsePatch(patch: string): ParsedDiff {
  const orig: string[] = []
  const mod: string[] = []
  let additions = 0
  let deletions = 0
  let inHunk = false

  for (const line of patch.split('\n')) {
    if (!inHunk) {
      if (line.startsWith('@@')) inHunk = true
      continue // skip diff --git / index / --- / +++ headers
    }
    if (line.startsWith('@@')) continue // next hunk
    if (line.startsWith('\\')) continue // "\ No newline at end of file"
    if (line.startsWith('+')) {
      mod.push(line.slice(1))
      orig.push('')
      additions++
    } else if (line.startsWith('-')) {
      orig.push(line.slice(1))
      mod.push('')
      deletions++
    } else if (line.startsWith(' ') || line === '') {
      const text = line.startsWith(' ') ? line.slice(1) : ''
      orig.push(text)
      mod.push(text)
    } else {
      inHunk = false // ran into a new file's header
    }
  }

  return { original: orig.join('\n'), modified: mod.join('\n'), additions, deletions }
}

interface Hunk {
  newStart: number
  newLines: string[]
  oldLines: string[]
}

// Reconstruct pre-change content by undoing each hunk against `modified`.
// Bottom-up application keeps earlier line offsets valid.
export function applyPatchReverse(modified: string, patch: string): string {
  const hunks: Hunk[] = []
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      const m = /@@ -\d+(?:,\d+)? \+(\d+)/.exec(line)
      hunks.push({ newStart: m ? Number(m[1]) : 1, newLines: [], oldLines: [] })
    } else if (hunks.length) {
      const cur = hunks[hunks.length - 1]
      if (line.startsWith('\\')) continue
      if (line.startsWith('+')) cur.newLines.push(line.slice(1))
      else if (line.startsWith('-')) cur.oldLines.push(line.slice(1))
      else if (line.startsWith(' ') || line === '') {
        const t = line.startsWith(' ') ? line.slice(1) : ''
        cur.newLines.push(t)
        cur.oldLines.push(t)
      }
      // anything else = next file's header; stop collecting this patch
      else break
    }
  }

  const lines = modified.split('\n')
  for (let i = hunks.length - 1; i >= 0; i--) {
    const h = hunks[i]
    if (!h.newLines.length) continue
    const idx =
      matchAt(lines, h.newLines, h.newStart - 1) ?? matchAt(lines, h.newLines, 0) ?? -1
    if (idx >= 0) lines.splice(idx, h.newLines.length, ...h.oldLines)
  }
  return lines.join('\n')
}

function matchAt(hay: string[], needle: string[], start: number): number | null {
  outer: for (let i = start; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return null
}
