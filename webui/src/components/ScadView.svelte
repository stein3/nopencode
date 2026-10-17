<script lang="ts">
  // Live 3D render of a .scad file, inline in the transcript. Compiles off the
  // main thread (lib/scad.ts) and draws the STL with three.js.
  //
  // ponytail: on-demand rendering (orbit/zoom/resize only, no rAF loop), one
  // solid material, no grid/axes/explode/section. WebGL is not compiled into
  // the OpenSCAD wasm build, so this is the only way to see a model.
  import { onMount } from 'svelte'
  import * as THREE from 'three'
  import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
  import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
  import { renderScad } from '../lib/scad'

  export let path: string

  let host: HTMLDivElement
  let error = ''
  let log = ''
  let loading = true

  let renderer: THREE.WebGLRenderer | null = null
  let scene: THREE.Scene | null = null
  let camera: THREE.PerspectiveCamera | null = null
  let controls: OrbitControls | null = null
  let mesh: THREE.Mesh | null = null
  let ro: ResizeObserver | null = null

  const name = path.slice(path.lastIndexOf('/') + 1)

  function render() {
    if (renderer && scene && camera) renderer.render(scene, camera)
  }

  function resize() {
    if (!renderer || !camera) return
    const w = host.clientWidth || 320
    const h = host.clientHeight || 240
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    render()
  }

  function clearMesh() {
    if (!scene || !mesh) return
    scene.remove(mesh)
    mesh.geometry.dispose()
    ;(mesh.material as THREE.Material).dispose()
    mesh = null
  }

  function draw(stl: ArrayBuffer) {
    if (!scene || !camera || !controls) return
    clearMesh()
    const geometry = new STLLoader().parse(stl)
    if (!geometry.attributes.position?.count) throw new Error('model is empty')
    geometry.computeBoundingBox()
    const box = geometry.boundingBox!
    const size = new THREE.Vector3()
    const center = new THREE.Vector3()
    box.getSize(size)
    box.getCenter(center)
    const radius = Math.max(size.length() / 2, 0.001)
    camera.near = radius / 100
    camera.far = radius * 40
    // zoom limits follow the model so it can neither vanish nor swallow the box
    controls.minDistance = radius * 0.15
    controls.maxDistance = radius * 12
    camera.updateProjectionMatrix()
    const dist = (radius / Math.sin(((camera.fov / 2) * Math.PI) / 180)) * 1.15
    camera.position.copy(center).add(new THREE.Vector3(0.5, -1, 0.5).normalize().multiplyScalar(dist))
    controls.target.copy(center)
    camera.lookAt(center)
    controls.update()
    mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ color: 0x9fb0c4, metalness: 0.15, roughness: 0.55 }),
    )
    scene.add(mesh)
    render()
  }

  async function show(p: string) {
    loading = true
    error = ''
    log = ''
    try {
      const res = await renderScad(p)
      if ('error' in res) {
        error = res.error
        log = res.log
      } else {
        log = res.log
        draw(res.stl)
      }
    } catch (e) {
      error = String((e as Error)?.message ?? e)
    }
    loading = false
  }

  // Transcript re-renders constantly while streaming and Svelte invalidates
  // component props on every parent update, so `$: show(path)` alone would
  // re-fetch the source and rebuild the mesh on every pass — run only when the
  // path actually changed.
  let shown = ''
  $: if (path !== shown) {
    shown = path
    show(path)
  }

  onMount(() => {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2))
    renderer.setSize(host.clientWidth || 320, host.clientHeight || 240, false)
    host.appendChild(renderer.domElement)
    scene = new THREE.Scene()
    camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000)
    // OpenSCAD is Z-up, and it must be set BEFORE OrbitControls is constructed:
    // the controls build their rotation basis from camera.up once, in the
    // constructor, and keep it (later changes are ignored) — setting up in
    // draw() leaves the drag math in a Y-up frame while lookAt() renders Z-up,
    // which makes drag direction and rotation disagree.
    camera.up.set(0, 0, 1)
    scene.add(new THREE.HemisphereLight(0xffffff, 0x2b2f36, 1.1))
    const key = new THREE.DirectionalLight(0xffffff, 1.8)
    key.position.set(1, -1.4, 1.8)
    scene.add(key)
    controls = new OrbitControls(camera, renderer.domElement)
    // three.js defaults: left-drag orbits, middle/wheel zooms, right-drag pans.
    // Orbit speed is halved — a full-canvas drag is ~90° at the default, which
    // is whippy in a 240px preview. No damping: it needs a continuous rAF loop
    // and this viewer renders on demand only.
    controls.rotateSpeed = 0.55
    controls.enableDamping = false
    controls.addEventListener('change', render)
    ro = new ResizeObserver(resize)
    ro.observe(host)
    render()
    return () => {
      ro?.disconnect()
      controls?.removeEventListener('change', render)
      controls?.dispose()
      clearMesh()
      renderer?.dispose()
      // a transcript can hold many viewers and browsers cap live GL contexts
      renderer?.forceContextLoss()
      renderer?.domElement.remove()
    }
  })
</script>

<div class="scadview">
  <div class="canvas" bind:this={host}></div>
  <div class="meta">
    <span class="fname">{name}</span>
    {#if loading}
      <span class="st">rendering…</span>
    {:else if error}
      <span class="st err">{error}</span>
    {:else if log}
      <span class="st" title={log}>{log}</span>
    {/if}
  </div>
</div>

<style>
  .scadview {
    margin: 8px 10px;
    width: min(420px, 100%);
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
    background: var(--bg-code);
  }
  .canvas {
    height: 240px;
    /* orbit on touch must not scroll the transcript */
    touch-action: none;
  }
  .canvas :global(canvas) {
    display: block;
  }
  .meta {
    display: flex;
    gap: 6px;
    align-items: baseline;
    padding: 4px 8px;
    border-top: 1px solid var(--border);
    font-size: 11px;
    color: var(--fg-dim);
    min-width: 0;
  }
  .fname {
    flex: none;
    color: var(--fg);
  }
  .st {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .st.err {
    color: var(--err);
  }
</style>
