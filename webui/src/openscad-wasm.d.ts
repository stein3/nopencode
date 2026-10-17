// The npm package ships no types (and no main/exports map — hence the subpath
// import in scad.worker.ts). This is the surface we use; see the package README
// for the build provenance.
declare module '@kreijstal/openscad-wasm/openscad.js' {
  export interface OpenSCADFS {
    mkdir(path: string): void
    writeFile(path: string, data: string): void
    readFile(path: string): Uint8Array
    unlink(path: string): void
  }

  export interface OpenSCADOptions {
    noInitialRun?: boolean
    print?: (line: string) => void
    printErr?: (line: string) => void
    /** Takes over wasm loading: call `ready(instance)` once instantiated. */
    instantiateWasm?: (
      imports: WebAssembly.Imports,
      ready: (instance: WebAssembly.Instance) => void,
    ) => Promise<void>
  }

  export interface OpenSCADModule {
    FS: OpenSCADFS
    /** Runs the OpenSCAD CLI once; returns its exit code (non-zero = failed). */
    callMain(argv: string[]): number
  }

  const OpenSCAD: (options?: OpenSCADOptions) => Promise<OpenSCADModule>
  export default OpenSCAD
}