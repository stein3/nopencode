import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
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
export default defineConfig({
  plugins: [svelte()],
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
