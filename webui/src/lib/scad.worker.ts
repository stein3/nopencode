/// <reference lib="webworker" />
// OpenSCAD compiled to WebAssembly (npm @kreijstal/openscad-wasm, exact-pinned:
// OpenSCAD 2026.07.26 built with emscripten). The engine's /file/content proxy
// hands the browser .scad source as text, so the model is compiled here: no
// openscad binary in the webui container, no GL.
//
// ponytail: renders are serialized by lib/scad.ts, nothing is re-rendered on
// edit, and `use`/`include` of sibling files is not resolved. A .scad with a
// runaway loop() wedges the worker with no way to interrupt it, so the main
// thread terminates and respawns it after a timeout.

import OpenSCAD from '@kreijstal/openscad-wasm/openscad.js'
import wasmUrl from '@kreijstal/openscad-wasm/openscad.wasm?url'

type Request = { id: number; source: string }
type Response =
  | { id: number; stl: ArrayBuffer; log: string }
  | { id: number; error: string; log: string }

// Compiling the 11 MB module once and instantiating it per render keeps the
// second render fast; OpenSCAD's main() runs once per instance, so an instance
// must never be reused (the second callMain aborts the program).
let compiled: WebAssembly.Module | null = null
let sink: string[] = []

async function openscad() {
  const m = await OpenSCAD({
    noInitialRun: true,
    print: () => {},
    printErr: (line) => sink.push(line),
    instantiateWasm: async (info, ready) => {
      compiled ??= await WebAssembly.compile(await (await fetch(wasmUrl)).arrayBuffer())
      ready(await WebAssembly.instantiate(compiled, info))
    },
  })
  try {
    m.FS.mkdir('/work')
  } catch {
    /* already there */
  }
  return m
}

function lines(): string[] {
  // the wasm build has no locale data, so this warning is always noise
  return sink.map((l) => l.trim()).filter((l) => l && !l.startsWith('Could not initialize localization'))
}

// ok: the CGAL/manifold stats tail makes a useful caption. failed: the parser
// and geometry diagnostics do.
function summary(ok: boolean): string {
  const all = lines()
  if (ok) return all.slice(-6).join(' · ')
  const errs = all.filter((l) => /^(ERROR|WARNING)/.test(l))
  return (errs.length ? errs.join(' · ') : all.slice(-3).join(' · ')).slice(0, 400)
}

self.onmessage = async (e: MessageEvent<Request>) => {
  const { id, source } = e.data
  sink = []
  try {
    const m = await openscad()
    m.FS.writeFile('/work/model.scad', source)
    const rc = m.callMain(['-o', '/work/out.stl', '/work/model.scad'])
    if (rc !== 0) throw new Error(summary(false))
    const raw = m.FS.readFile('/work/out.stl')
    // slice() copies so .buffer is a standalone ArrayBuffer we can transfer
    const stl = raw.slice().buffer as ArrayBuffer
    const res: Response = { id, stl, log: summary(true) }
    ;(self as unknown as Worker).postMessage(res, [stl])
  } catch (err) {
    const res: Response = { id, error: String((err as Error)?.message ?? err).slice(0, 400), log: '' }
    ;(self as unknown as Worker).postMessage(res)
  }
}
