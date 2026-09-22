# /workspace/opencode — ttyd/webui stack

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

- **Frozen reactive expressions**: a function called in a template (`{fn($store)}`) only re-runs when the function *binding* is dirtied — reactive vars read *inside* the body are invisible to the compiler. Fix: `$: result = fn($store)` and render `{result}`. Affected: ModelPicker label, CommandPalette sid resolution, rename dialog seeding.
- **localStorage invisible to reactivity**: `$: x = localStorage.getItem(...)` never re-runs when localStorage changes. Keep such data in a writable store.
- **Attribute type coercion**: `open={p.id === someBoolean}` (string vs boolean) is silently always-false — no build-time error.

### Architecture

- **chatserver.py is stateless** — every request runs its own SQL against opencode.db. No in-memory DB materialization.
- **FTS5 search** lives in `webui.db` (writable sidecar), not `opencode.db` (read-only). Trigram index, incremental sync every 30s.
- **Pane dormancy** (`PANE_KEEP=5`): inactive tab panes stay mounted under `display:none` with a `dormant` prop — remount is instant from memory.
- **`content-visibility:auto`** on `.msg` rows — offscreen rows skip style/layout/paint.
- **DiffPane/monaco are lazy-loaded** (`{#await import(...)}`) — do not statically import.
- **Monaco codicon font** must be explicitly imported in DiffPane or glyph icons render blank.

### Engine API traps

- `POST /session/{id}/message` while busy **does not error** — engine queues the turn.
- `POST /session/{id}/prompt_async` returns 204 immediately; UI state comes from SSE.
- **Eager image decode**: corrupt image at prompt time → `session.error` + entire message dropped, nothing persists.
- Session-level `tokens` on `GET /session/{id}` are **cumulative all-turn totals**, NOT context size — never use for "% used".
- `/permission` items have NO `title`, `pattern`, `path`, or `type` field. Use `patterns[0]` for file path, `metadata.input` for command.
- `POST /session/{id}/fork` takes undocumented `{messageID}` body — exclusive copy before that message.

### E2E tests

- Fake servers serve `webui/dist` from disk — **always `npm run build` first** or tests run stale code.
- `waitUntil:'networkidle'` never fires (SSE keeps connection open) — use `domcontentloaded`.
- `POST /session/{id}/message` with `noReply:true` + parts = cheap way to seed fixtures without an LLM.
- Each test owns a unique PORT — check siblings before picking one.
- `launchBrowser()` in `e2e/helpers/setup.mjs` bakes in swiftshader + font flags for sandbox.

### Mobile

- Chrome Android ≥108: viewport meta must include `interactive-widget=resizes-content`.
- All `100vh` sites use `@supports (height:100dvh)` guard — bare `var(--vvh,100dvh)` outside @supports breaks on engines without dvh.

### Streaming / rendering

- `markdown.ts md(src, live=false)`: live path has fence caps (unlabeled >4k / labeled >50k → plaintext). **Transcript's `renderCache` is written ONLY by the non-live path** — live renders must never satisfy a later final-quality lookup.
- Delta coalescing in `sse.ts`: `message.part.delta` chunks buffered per key with ~40ms flush; `message.part.updated` snapshot ALWAYS drops buffered deltas first to prevent duplication.
- `scheduleRefetch()` gated on `!busy` in `message.updated` handler — otherwise in-progress thinking text gets overwritten by stale engine snapshots.
