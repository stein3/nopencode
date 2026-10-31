# nopencode — ttyd/webui stack

Svelte 4 SPA (`webui/`) served by a stateless Python proxy (`chatserver.py`) in front of a
headless `opencode serve` engine. Two independent container images: `Dockerfile` (engine,
incl. ttyd + `inject.py`) and `Dockerfile.web` (chatserver + built `webui/dist`).

## Build & deploy

- **Two independent builds**: `Dockerfile` (engine) and `Dockerfile.web` (web). Changing `webui/` or `chatserver.py` does not bust the engine build cache.
- Deploy: `sudo docker compose up -d --build`. Web-only rebuild: `sudo docker compose up -d --build --no-deps opencode-web`.
- `compose.yaml` `init: true` is required — without it PID 1 doesn't reap children and zombies accumulate.
- CI: `.github/workflows/e2e.yml` builds the dist once, its `build` job **fails on any `A11y:` warning** the svelte compiler emits, and its test matrix is **generated from `e2e/embedded/*.test.mjs`** — one job per file, so a test is gated the moment it lands and the workflow holds no list to keep current.

## Non-obvious patterns

### Svelte gotchas

- **Frozen reactive expressions**: a function called in a template (`{fn($store)}`) only re-runs when the function *binding* is dirtied — reactive vars read *inside* the body are invisible to the compiler. Fix: `$: result = fn($store)` and render `{result}`.
- **localStorage invisible to reactivity**: `$: x = localStorage.getItem(...)` never re-runs when localStorage changes. Keep such data in a writable store.
- **A reactive block that mutates its own dep loops**: gate on the counter *changing* (`$sessionListDirty !== linkedDirtySeen`), never on `> 0` — a timer callback clearing the flag re-fires the block into a permanent 250 ms fetch loop.

### Architecture

- **chatserver.py is stateless** — every request runs its own SQL against opencode.db. No in-memory DB materialization.
- **FTS5 search** lives in `webui.db` (writable sidecar), not `opencode.db` (read-only). Trigram index, incremental sync every 30s.
- **Never put `content-visibility:auto` on `.msg` rows.** It was the transcript's perf win and was **removed** in `e532dc8`: with `contain-intrinsic-size: auto 160px`, rows swapping from the estimate to real height as they entered view gave up to ~3.9k px of scroll-anchor motion. Every row lays out for real; don't "restore the optimization."
- **Monaco codicon font** must be explicitly imported in DiffPane or glyph icons render blank.
- **Statics**: hashed `/assets/*` are `Cache-Control: immutable`; `index.html` is served whole (`no-store`, no ETag) because it carries the per-request CSP nonce — a 304 would pair a cached body with a fresh CSP header and block the inline theme script. The same dist is served at `/` and `/webui/` (chatserver strips the prefix).
- **The Vite base defaults to `/`** and nothing in this repo may assume otherwise. `WEBUI_BASE` is an escape hatch for one hosting shape — the UI under a subpath behind a prefix-stripping proxy (Caddy `handle_path /webui/*`) — where the browser must request `/webui/assets/*`. A personal-hosting choice, not a repo behaviour.

### Engine API traps

- **Eager image decode**: corrupt image at prompt time → `session.error` + entire message dropped, nothing persists.
- `/permission` items have NO `title`, `pattern`, `path`, or `type` field. Use `patterns[0]` for file path, `metadata.input` for command.
- `POST /session/{id}/fork` takes undocumented `{messageID}` body — exclusive copy before that message.

### E2E tests

Authoring details (fake-engine server shape, seeding with `noReply:true`, `domcontentloaded` vs `networkidle`, Playwright install) live in **`e2e/README.md`** — read it before writing or debugging a test. The ones that bite hardest:

- Each test owns a unique PORT — check siblings before picking one.
- **`poll()` footgun**: `poll(() => el.count() === 0, T)` always times out — `count()` returns a Promise and `Promise === 0` is false. Always await: `poll(async () => (await el.count()) === 0, T)`.
- **Locator reads must `waitFor({state:'attached'})` before `textContent()`** — a bare `count()` races the history render and fails a check whose node exists 5 ms later.
- **A tool row's output box keys off `state.output`, never the tool name**, and mounts its body only while expanded (a `read` result can be 50 KB).

### Mobile

- Chrome Android ≥108: viewport meta must include `interactive-widget=resizes-content`.
- All `100vh` sites use an `@supports (height:100dvh)` guard — bare `var(--vvh,100dvh)` outside @supports breaks on engines without dvh.

### Streaming / rendering

- **Turn status is ONE slot: the Footer's `.status_indicator`** (variants `.thinking` / `.compacting`). The footer's three zones need **equal `flex: 1 1 0` shares on the side zones** — that is what keeps the middle dead-centre whatever the numbers read. The `@media (max-width:380px)` rule that drops the cylon **must sit after `.cmd`/`.cylon`** in the stylesheet: same specificity, an earlier copy silently loses. ComposerToolbar carries no status; the footer never prints the session's cwd. Transcript's `.cmpbox.running` is **telemetry-only**, so its sibling failure branch must exclude `state === 'running'` — otherwise a summary with no engine to ask renders "Compaction failed".
- `headings=false` (user-role messages only — Transcript passes `m.role !== 'user'`): suppression MUST live in `renderer.heading`, never as a pre-escape regex — `\#` corrupts `# comments` inside ``` fences. Returning `false` from the override delegates to marked's default; `''` swallows the heading. Agent/reasoning/subagent text keeps full markdown.
- Delta coalescing in `sse.ts`: `message.part.delta` chunks buffered per key with ~40ms flush; `message.part.updated` snapshot ALWAYS drops buffered deltas first to prevent duplication.
- `scheduleRefetch()` gated on `!busy` in `message.updated` — otherwise in-progress thinking text gets overwritten by a stale engine snapshot.
