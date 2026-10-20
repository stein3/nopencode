# nopencode — ttyd/webui stack

## Navigation

| Path | What |
|------|------|
| `chatserver.py` | Stateless Python HTTP server — proxies engine API, serves webui, owns search (FTS5 in webui.db) |
| `webui/` | Svelte 4 + Vite frontend (`npm run build` → `webui/dist`, git-ignored) |
| `webui/src/lib/` | Core libs: `api.ts` (engine client), `sse.ts` (SSE/event stream), `stores.ts` (Svelte stores), `markdown.ts`, `retries.ts` |
| `webui/src/components/` | Svelte components: `App.svelte`, `Transcript.svelte`, `Sidebar.svelte`, `Composer.svelte`, `DiffPane.svelte` |
| `Dockerfile` | Engine image (opencode CLI + ttyd + inject.py) |
| `Dockerfile.web` | Web image (python:3.12-slim + chatserver.py + webui/dist) |
| `compose.yaml` | Service orchestration. `x-limits` anchor for shared caps |
| `inject.py` | HTML patcher for ttyd's index.html |
| `start.sh` | Engine container entrypoint |
| `e2e/embedded/` | Self-contained headless tests (fake engine servers, no deploy needed) |

## Build & deploy

- **`webui/dist` is git-ignored** — never hand-edit. Local: `cd webui && npm run build`. Docker: `docker compose build`.
- **Two independent builds**: `Dockerfile` (engine) and `Dockerfile.web` (web). Changing `webui/` or `chatserver.py` does not bust the engine build cache.
- Deploy: `sudo docker compose up -d --build`. Web-only rebuild: `sudo docker compose up -d --build --no-deps opencode-web`.
- `compose.yaml` `init: true` is required — without it PID 1 doesn't reap children and zombies accumulate.

## Non-obvious patterns

### Svelte gotchas

- **Frozen reactive expressions**: a function called in a template (`{fn($store)}`) only re-runs when the function *binding* is dirtied — reactive vars read *inside* the body are invisible to the compiler. Fix: `$: result = fn($store)` and render `{result}`. Affected: ComposerModelPicker label, CommandPalette sid resolution, rename dialog seeding.
- **localStorage invisible to reactivity**: `$: x = localStorage.getItem(...)` never re-runs when localStorage changes. Keep such data in a writable store.
- **Attribute type coercion**: `open={p.id === someBoolean}` (string vs boolean) is silently always-false — no build-time error.
- **A reactive block that mutates its own dep loops**: InfoPanel's `$: if ($sessionListDirty > 0 && !linkedDirtyTimer)` re-fired the instant the timer callback reset `linkedDirtyTimer = undefined` → permanent 250 ms `hist.sessions()` + `oc.status()` hammer. React on the counter *changing* (`$sessionListDirty !== linkedDirtySeen`), not on `> 0`.

### Architecture

- **chatserver.py is stateless** — every request runs its own SQL against opencode.db. No in-memory DB materialization.
- **FTS5 search** lives in `webui.db` (writable sidecar), not `opencode.db` (read-only). Trigram index, incremental sync every 30s.
- **Pane dormancy** (`PANE_KEEP=5`): inactive tab panes stay mounted under `display:none` with a `dormant` prop — remount is instant from memory.
- **`content-visibility:auto`** on `.msg` rows — offscreen rows skip style/layout/paint.
- **DiffPane/monaco are lazy-loaded** (`{#await import(...)}`) — do not statically import.
- **Monaco codicon font** must be explicitly imported in DiffPane or glyph icons render blank.
- **Statics**: hashed `/assets/*` are `Cache-Control: immutable`; `index.html` is served whole (`no-store`, no ETag) because it carries the per-request CSP nonce — a 304 would pair a cached body with a fresh CSP header and block the inline theme script. The same dist is served at `/` and `/webui/` (chatserver strips the prefix).
- **Agent picker**: picks are per-session (`sessionAgents` localStorage, migrated by `rekeySessionAgent` on pending-tab realize); collapsed label and first menu row show the *resolved* default (`session.agent` → `agents()[0]` → "Auto"). Field omitted from the prompt when no pick.
- **Session model coordination (cross-client)**: the engine's `GET /session/{id}.model` is the source of truth — every prompt that carries a model updates it **synchronously before its 204**, from any client. Read chain, in order: `sessionModels[sid]` (an explicit pick on THIS device) → `sessionSyncedModels[sid]` (engine value, refreshed in `App.openLive`, in-memory only) → global `selectedModel`. One helper (`effectiveSessionModel`) backs Composer.send + retries; the pickers (`ComposerModelPicker`, empty-state `ModelSelect`) render the same chain. **Never** echo `session.model` into `selectedModel` (the old "model didn't stick" bug) and never lock a send into `sessionModels` (that froze one device's stale cache over another device's newer model). Verify: `e2e/embedded/model-sync.test.mjs`.
- **`.scad` viewer** (`ScadView.svelte` + `lib/scad*.ts`): read-tool parts of `.scad` files render inline 3D. Source comes from the engine's `/file/content` (text), compiles via OpenSCAD wasm in a worker, draws with three.js. The wasm is the npm dep `@kreijstal/openscad-wasm`, **exact-pinned** (no `main`/`exports` map → subpath import; types hand-written in `src/openscad-wasm.d.ts`). Traps: CSP needs `'wasm-unsafe-eval'` (chatserver `_apply_security`); the wasm build has no GL so **only mesh export** (no PNG); `main()` runs **once per instance** — a fresh `OpenSCAD()` per render, only the compiled `WebAssembly.Module` is cached; results are cached by SOURCE, not path (a path-keyed cache served stale geometry after a re-read of an edited file), and `$: show(path)` is guarded by a `shown` local because Svelte re-invalidates props on every parent update — Transcript re-renders constantly while streaming; `camera.up` must be set BEFORE `new OrbitControls(...)` — the controls build their rotation basis once in the constructor, so a later change leaves the drag math and `lookAt` in different frames and orbit feels non-logical; the 11 MB wasm is `globIgnore`d from the PWA precache (Vite names the asset after the source file, so the glob still matches when installed from npm).

### Engine API traps

- `POST /session/{id}/message` while busy **does not error** — engine queues the turn.
- `POST /session/{id}/prompt_async` returns 204 immediately; UI state comes from SSE.
- **Eager image decode**: corrupt image at prompt time → `session.error` + entire message dropped, nothing persists.
- Session-level `tokens` on `GET /session/{id}` are **cumulative all-turn totals**, NOT context size — never use for "% used".
- `/permission` items have NO `title`, `pattern`, `path`, or `type` field. Use `patterns[0]` for file path, `metadata.input` for command.
- `POST /session/{id}/fork` takes undocumented `{messageID}` body — exclusive copy before that message.
- **`POST /api/session/{id}/model` (switchModel) 500s for every session created after ~2026-10-05**: it inserts a `model-switched` row into `session_message`, whose FK targets `session_v2(id)`, but new sessions only land in `session` (v1) — `SQLiteError: FOREIGN KEY constraint failed`, ref `err_*` in `log/opencode.log`. The webui's `oc.setSessionModel` swallows it (`.catch(() => {})`), so a picker pick does NOT reach the engine until the next prompt carries it in the body. Engine-side (opencode 1.18.18); prompt bodies are the only working write path meanwhile.

### E2E tests

- Fake servers serve `webui/dist` from disk — **always `npm run build` first** or tests run stale code.
- `waitUntil:'networkidle'` never fires (SSE keeps connection open) — use `domcontentloaded`.
- `POST /session/{id}/message` with `noReply:true` + parts = cheap way to seed fixtures without an LLM.
- Each test owns a unique PORT — check siblings before picking one.
- `launchBrowser()` in `e2e/helpers/setup.mjs` bakes in swiftshader + font flags for sandbox.
- **`poll()` footgun**: `poll(() => el.count() === 0, T)` always times out — `count()` returns a Promise and `Promise === 0` is false. Always await: `poll(async () => (await el.count()) === 0, T)`.
- Agent-picker fixtures need the dist built as `WEBUI_BASE=/ npm run build` — with the default `/webui/` base the fake's static handler 404s `/webui/assets/*` and nothing renders (masquerades as a picker bug).
- Same trap applies to ANY embedded test that waits on `.msg` / `.sidebar` (modelid, tasknotice, …): default-base dist ⇒ blank app, not a fixture bug. Build `WEBUI_BASE=/` before running them.
- `~/.cache/ms-playwright` can be empty in a fresh sandbox — every embedded test dies with "Executable doesn't exist". Restore: `cd e2e && node node_modules/playwright-core/cli.js install chromium-headless-shell`.

### Mobile

- Chrome Android ≥108: viewport meta must include `interactive-widget=resizes-content`.
- All `100vh` sites use `@supports (height:100dvh)` guard — bare `var(--vvh,100dvh)` outside @supports breaks on engines without dvh.

### Streaming / rendering

- `markdown.ts md(src, live=false, headings=true)`: live path has fence caps (unlabeled >4k / labeled >50k → plaintext). **Transcript's `renderCache` is written ONLY by the non-live path** — live renders must never satisfy a later final-quality lookup.
- `headings=false` (user-role messages only — Transcript passes `m.role !== 'user'`): `renderer.heading` returns the raw line as literal `<p>` (token.raw carries the `#`/setext markers; trailing `\n` trimmed). Suppression MUST live in the renderer, never as a pre-escape regex — `\#` corrupts `# comments` inside ``` fences. Returning `false` from the override delegates to marked's default (the `marked.use` wrapper falls back only on strict `false`; `''` swallows the heading). Agent/reasoning/subagent text keeps full markdown. Guard: `e2e/embedded/user-md.test.mjs`.
- Delta coalescing in `sse.ts`: `message.part.delta` chunks buffered per key with ~40ms flush; `message.part.updated` snapshot ALWAYS drops buffered deltas first to prevent duplication.
- `scheduleRefetch()` gated on `!busy` in `message.updated` handler — otherwise in-progress thinking text gets overwritten by stale engine snapshots.
- `streamThrottle` stale-serves ≤120 ms (`STREAM_THROTTLE_MS`); a stale serve must schedule `throttleTick++` at window expiry or a burst whose final delta lands inside the window never re-renders ("streamed text missing until I click").
- **EventSource dies permanently on any non-200 / wrong-MIME response** (spec: CLOSED, no retry) — the client owns recreation: `openStream()`/`scheduleRecreate()` (1s → 15s backoff, 10s watchdog, `visibilitychange`/`online` resume) + `catchUp()` on every re-open (patch per-tab `busy` from the status map first — a missed `session.idle` pins `busy=true` forever — then refetch non-busy open tabs).
- **While busy**: re-opening an already-open busy tab activates without wipe/refetch (`openHistory` guard — the `messages: []` merge is load-bearing for the idle refresh path); `applyMessages` is add-only mid-turn (append missing, never truncate delta-ahead text). chatserver's `/oc/event` closes with no response on engine-down (browser retries) instead of a JSON 500 (spec-fatal, never retried). Verify: `e2e/embedded/sse-resilience.test.mjs`.
