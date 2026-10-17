// OpenSCAD rendering in the browser: the engine's /file/content proxy already
// serves .scad source as text (see lib/images.ts for the same dance), a
// vendored WebAssembly OpenSCAD compiles it to STL in a worker, and
// ScadView.svelte draws the mesh.
//
// ponytail: one worker, renders serialized, results cached by SOURCE (STLs run
// ~1 MB each, so the cap is small), no re-render on demand and no handling of
// `use`/`include` of sibling files.

type ScadResult = { stl: ArrayBuffer; log: string } | { error: string; log: string }

type Done = { id: number; log: string } & ({ stl: ArrayBuffer } | { error: string })

const TIMEOUT_MS = 120_000
const CACHE_CAP = 6

let worker: Worker | null = null
let nextId = 1
let chain: Promise<unknown> = Promise.resolve()
const pending = new Map<number, { resolve: (r: ScadResult) => void; timer: ReturnType<typeof setTimeout> }>()
const cache = new Map<string, Promise<ScadResult>>()

// Dropping the worker fails every render in flight, otherwise their viewers
// hang on "rendering…" forever — a .scad with a runaway loop() cannot be
// interrupted, and the next render just respawns it.
function kill(reason: string) {
  const w = worker
  worker = null
  for (const [id, p] of pending) {
    pending.delete(id)
    clearTimeout(p.timer)
    p.resolve({ error: reason, log: '' })
  }
  w?.terminate()
}

function spawn(): Worker {
  const w = new Worker(new URL('./scad.worker.ts', import.meta.url), { type: 'module' })
  w.onmessage = (e: MessageEvent<Done>) => {
    const p = pending.get(e.data.id)
    if (!p) return
    pending.delete(e.data.id)
    clearTimeout(p.timer)
    const d = e.data
    p.resolve('stl' in d ? { stl: d.stl, log: d.log } : { error: d.error, log: d.log })
  }
  w.onerror = (e) => kill(e.message || 'openscad worker failed')
  return w
}

function post(source: string): Promise<ScadResult> {
  return new Promise((resolve) => {
    const w = (worker ??= spawn())
    const id = nextId++
    const timer = setTimeout(() => kill('render timed out — check for a runaway loop() in the .scad'), TIMEOUT_MS)
    pending.set(id, { resolve, timer })
    w.postMessage({ id, source })
  })
}

// OpenSCAD is one instance on one thread; the module's log sink is shared, so
// renders must not overlap.
function enqueue(source: string): Promise<ScadResult> {
  const run = chain.then(
    () => post(source),
    () => post(source),
  )
  chain = run.catch(() => {})
  return run
}

async function source(path: string): Promise<string> {
  const r = await fetch(`/oc/file/content?path=${encodeURIComponent(path)}`)
  if (!r.ok) throw new Error(`${r.status}`)
  const d: { content?: string } = await r.json()
  const s = d.content ?? ''
  if (!s) throw new Error('no content')
  return s
}

export function renderScad(path: string): Promise<ScadResult> {
  return source(path).then(compile)
}

// Cached by source, not by path: keying on the path served a stale STL after a
// re-read of an edited file. The source re-read is ~13 KB over a local proxy —
// cheap next to recompiling, and identical text still hits the cache.
function compile(src: string): Promise<ScadResult> {
  let p = cache.get(src)
  if (!p) {
    p = enqueue(src)
    // a failing render must not be cached — the next read may differ
    p.catch(() => cache.delete(src))
    cache.set(src, p)
    while (cache.size > CACHE_CAP) {
      const oldest = cache.keys().next().value
      if (oldest === undefined || oldest === src) break
      cache.delete(oldest)
    }
  }
  return p
}
