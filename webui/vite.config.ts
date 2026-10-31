import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath } from 'node:url'

// monaco-editor's exports map forces subpaths to *.js, so its codicon
// stylesheet (needed for all glyph icons) can't be imported directly;
// alias it to the real file on disk.
const monacoCodiconCss = fileURLToPath(
  new URL(
    './node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css',
    import.meta.url,
  ),
)

// Dev mode proxies: `npm run dev` expects a local engine on :4096
// and chatserver.py on :8080. Production serves everything same-origin.
// Engine URL is overridable via OC_ENGINE (default :4096) so `npm run dev`
// can target any local `opencode serve` instance.
const ocEngine = process.env.OC_ENGINE || 'http://127.0.0.1:4096'

// The build defaults to Vite base '/', which is what every real consumer of this
// dist wants: chatserver.py and pi-web both serve it at `/` (and both also strip
// a `/webui/` prefix for old links), and the embedded e2e fake servers serve it at
// `/`. PWA manifest/service-worker/icon URLs and manifest `id`/`scope` follow
// `base`, so a root build is installable at the root.
//
// WEBUI_BASE is an escape hatch for ONE deployment shape: hosting the UI under a
// subpath behind a prefix-stripping proxy (e.g. Caddy `handle_path /webui/*`).
// There the browser must request `/webui/assets/...`, so build with
// `WEBUI_BASE=/webui/`. That is a host-routing choice, not a repo default — do
// not make anything in this repo depend on it. Runtime `fetch('/oc/*')` and
// `fetch('/api/*')` are hardcoded-absolute in api.ts and unaffected by base.
const base = process.env.WEBUI_BASE || '/'
export default defineConfig({
  base,
  plugins: [
    svelte(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['fonts/*.woff2'],
      workbox: {
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024, // 4 MiB — DiffPane lazy chunk is ~2.7 MB
        // the OpenSCAD wasm (11 MB) is fetched lazily by the .scad viewer;
        // precaching it would bloat every install for a feature most sessions
        // never touch
        globIgnores: ['**/openscad-*.wasm'],
      },
      manifest: {
        name: 'nopencode',
        short_name: 'nopencode',
        id: base,
        description: 'AI coding assistant',
        theme_color: '#1e1e1e',
        background_color: '#1e1e1e',
        display: 'fullscreen',
        scope: base,
        start_url: base,
        icons: [
          { src: `${base}icons/icon-192x192.png`, sizes: '192x192', type: 'image/png' },
          { src: `${base}icons/icon-512x512.png`, sizes: '512x512', type: 'image/png' },
          { src: `${base}icons/icon-512x512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  resolve: {
    alias: [{ find: 'monaco-codicons.css', replacement: monacoCodiconCss }],
  },
  html: {
    // Emit a stable nonce placeholder into inline <script>/<style> tags in the
    // built index.html; chatserver.py swaps it for a per-request nonce and sets
    // the matching CSP script-src (strict: no inline scripts can execute).
    cspNonce: 'OPENCODE_CSP_NONCE',
  },
  server: {
    host: true, // listen on 0.0.0.0 so desktops can reach http://<ip>:5173
    port: 5173,
    proxy: {
      '/oc': {
        target: ocEngine,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/oc/, ''),
      },
      '/api': 'http://127.0.0.1:8080',
    },
  },
})
