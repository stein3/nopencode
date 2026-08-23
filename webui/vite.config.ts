import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// Dev mode proxies: `npm run dev` expects a local engine on :4096
// and chatserver.py on :8080. Production serves everything same-origin.
export default defineConfig({
  plugins: [svelte()],
  server: {
    host: true, // listen on 0.0.0.0 so desktops can reach http://<ip>:5173
    port: 5173,
    proxy: {
      '/oc': {
        target: 'http://127.0.0.1:4096',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/oc/, ''),
      },
      '/api': 'http://127.0.0.1:8080',
    },
  },
})
