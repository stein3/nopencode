# nopencode — ttyd/webui stack

## Navigation

| Path | What |
|------|------|
| `chatserver.py` | Stateless Python HTTP server — proxies engine API, serves webui, owns search (FTS5 in webui.db) |
| `webui/` | Svelte 4 + Vite frontend (`npm run build` → `webui/dist`, git-ignored) |
| `webui/src/lib/` | Core libs: `api.ts` (engine client), `sse.ts` (SSE/event stream), `stores.ts` (Svelte stores), `markdown.ts`, `retries.ts` |
| `webui/src/components/` | Svelte components: `App.svelte`, `Transcript.svelte`, `Sidebar.svelte`, `Composer.svelte`, `DiffPane.svelte` |
| `Dockerfile` | Engine image (opencode CLI + ttyd + inject.py + python 3.13 via COPY --from python:3.13-slim-bookworm; apt python3 3.11 kept for its runtime libs) |
| `Dockerfile.web` | Web image (python:3.13-slim + chatserver.py + webui/dist) |
| `compose.yaml` | Service orchestration. `x-limits` anchor for shared caps |
| `inject.py` | HTML patcher for ttyd's index.html |
| `start.sh` | Engine container entrypoint |
| `e2e/embedded/` | Self-contained headless tests (fake engine servers, no deploy needed) |

## Build & deploy

- **Two independent builds**: `Dockerfile` (engine) and `Dockerfile.web` (web). Changing `webui/` or `chatserver.py` does not bust the engine build cache.
- Deploy: `sudo docker compose up -d --build`. Web-only rebuild: `sudo docker compose up -d --build --no-deps opencode-web`.
- `compose.yaml` `init: true` is required — without it PID 1 doesn't reap children and zombies accumulate.

## Non-obvious patterns

### Svelte gotchas

- **Frozen reactive expressions**: a function called in a template (`{fn($store)}`) only re-runs when the function *binding* is dirtied — reactive vars read *inside* the body are invisible to the compiler. Fix: `$: result = fn($store)` and render `{result}`. Affected: ComposerModelPicker label, CommandPalette sid resolution, rename dialog seeding.
- **localStorage invisible to reactivity**: `$: x = localStorage.getItem(...)` never re-runs when localStorage changes. Keep such data in a writable store.
- **A reactive block that mutates its own dep loops**: InfoPanel's `$: if ($sessionListDirty > 0 && !linkedDirtyTimer)` re-fired the instant the timer callback reset `linkedDirtyTimer = undefined` → permanent 250 ms `hist.sessions()` + `oc.status()` hammer. React on the counter *changing* (`$sessionListDirty !== linkedDirtySeen`), not on `> 0`.

### Architecture

- **chatserver.py is stateless** — every request runs its own SQL against opencode.db. No in-memory DB materialization.
- **FTS5 search** lives in `webui.db` (writable sidecar), not `opencode.db` (read-only). Trigram index, incremental sync every 30s.
- **`content-visibility:auto`** on `.msg` rows — offscreen rows skip style/layout/paint.
- **Monaco codicon font** must be explicitly imported in DiffPane or glyph icons render blank.
- **Statics**: hashed `/assets/*` are `Cache-Control: immutable`; `index.html` is served whole (`no-store`, no ETag) because it carries the per-request CSP nonce — a 304 would pair a cached body with a fresh CSP header and block the inline theme script. The same dist is served at `/` and `/webui/` (chatserver strips the prefix).
- **`.scad` viewer** (`ScadView.svelte` + `lib/scad*.ts`): read-tool parts of `.scad` files render inline 3D. Source comes from the engine's `/file/content` (text), compiles via OpenSCAD wasm in a worker, draws with three.js. The wasm is the npm dep `@kreijstal/openscad-wasm`, **exact-pinned** (no `main`/`exports` map → subpath import; types hand-written in `src/openscad-wasm.d.ts`). Traps: CSP needs `'wasm-unsafe-eval'` (chatserver `_apply_security`); the wasm build has no GL so **only mesh export** (no PNG); `main()` runs **once per instance** — a fresh `OpenSCAD()` per render, only the compiled `WebAssembly.Module` is cached; results are cached by SOURCE, not path (a path-keyed cache served stale geometry after a re-read of an edited file), and `$: show(path)` is guarded by a `shown` local because Svelte re-invalidates props on every parent update — Transcript re-renders constantly while streaming; `camera.up` must be set BEFORE `new OrbitControls(...)` — the controls build their rotation basis once in the constructor, so a later change leaves the drag math and `lookAt` in different frames and orbit feels non-logical; the 11 MB wasm is `globIgnore`d from the PWA precache (Vite names the asset after the source file, so the glob still matches when installed from npm).

### Engine API traps

- **Eager image decode**: corrupt image at prompt time → `session.error` + entire message dropped, nothing persists.
- `/permission` items have NO `title`, `pattern`, `path`, or `type` field. Use `patterns[0]` for file path, `metadata.input` for command.
- `POST /session/{id}/fork` takes undocumented `{messageID}` body — exclusive copy before that message.
### E2E tests

- `waitUntil:'networkidle'` never fires (SSE keeps connection open) — use `domcontentloaded`.
- `POST /session/{id}/message` with `noReply:true` + parts = cheap way to seed fixtures without an LLM.
- Each test owns a unique PORT — check siblings before picking one.
- **`poll()` footgun**: `poll(() => el.count() === 0, T)` always times out — `count()` returns a Promise and `Promise === 0` is false. Always await: `poll(async () => (await el.count()) === 0, T)`.
- Agent-picker fixtures need the dist built as `WEBUI_BASE=/ npm run build` — with the default `/webui/` base the fake's static handler 404s `/webui/assets/*` and nothing renders (masquerades as a picker bug).
- `~/.cache/ms-playwright` can be empty in a fresh sandbox — every embedded test dies with "Executable doesn't exist". Restore: `cd e2e && node node_modules/playwright-core/cli.js install chromium-headless-shell`.

### Mobile

- Chrome Android ≥108: viewport meta must include `interactive-widget=resizes-content`.
- All `100vh` sites use `@supports (height:100dvh)` guard — bare `var(--vvh,100dvh)` outside @supports breaks on engines without dvh.

### Streaming / rendering

- `headings=false` (user-role messages only — Transcript passes `m.role !== 'user'`): `renderer.heading` returns the raw line as literal `<p>` (token.raw carries the `#`/setext markers; trailing `\n` trimmed). Suppression MUST live in the renderer, never as a pre-escape regex — `\#` corrupts `# comments` inside ``` fences. Returning `false` from the override delegates to marked's default (the `marked.use` wrapper falls back only on strict `false`; `''` swallows the heading). Agent/reasoning/subagent text keeps full markdown. Guard: `e2e/embedded/user-md.test.mjs`.
- Delta coalescing in `sse.ts`: `message.part.delta` chunks buffered per key with ~40ms flush; `message.part.updated` snapshot ALWAYS drops buffered deltas first to prevent duplication.
- `scheduleRefetch()` gated on `!busy` in `message.updated` handler — otherwise in-progress thinking text gets overwritten by stale engine snapshots.
