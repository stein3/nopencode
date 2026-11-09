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

### Token cost display

- **Token stats are PER BLOCK, never per message head** (`Transcript.svelte blockChips`). The engine measures usage per STEP, so a block gets the measured figure for its own kind — `reasoning` → the thinking summary, `output` → the reply text — and the step's clock (`Xs`, `t/s`) is stamped once on its last generating block. Several blocks of one kind split that measured total by character share and render `≈`. Tool rows show their own char estimate (`≈N tok` badge, floor 30 tok, warn colour at 2000).
- **The step's PROMPT total is not in the transcript.** It is the context the step was sent, which the footer's context meter already reports, and its amber used to key off the *previous* turn's output — a number about one block's colour that described another block's work. `promptTally`/`promptTip` remain for the InfoPanel's "Prompt cost" split only.
- **Sidebar row = fresh INPUT + OUTPUT, subagent subtree included** (`lib/gentokens.ts sessTok`, fed by `tokens_input` + `tokens_generated` from chatserver / pi-web, overlaid by live `sessionMetrics.prompt`). `input` means `input + cache.write`; prompt-cache RE-READS are in neither half, and neither half is the newest-message context estimate the footer/InfoPanel show. Label-free (`12 msgs - 8K - model`); the tooltip spells both halves out.
- **Never attribute MEASURED input tokens to one tool call.** `input` is the *uncached* part only, so on a cache miss it jumps to the whole prompt (measured: 74,404 after a 2,327 step); step-to-step prompt-token deltas are also polluted by branch jumps in the session JSONL tree. The per-call figure is therefore a char estimate: **tokens = chars × 0.305** (calibrated on 2,641 consecutive step pairs of real history; median 0.307 tok/char, divisor p25 3.62 / p75 2.80). `chars/4` — used elsewhere in the stack — under-reads tool output ~20%.
- **Keep the fresh and re-read halves separate.** A summed "prompt tokens" double-counts the context re-sent every turn (one 79-message session: 5.21M re-read vs 56K fresh), same trap as the old sidebar token stat — which is why the row sums `input + cache.write` only.

### Svelte / e2e assertion traps

- **`{@const}` must be an immediate child of `{#if}` / `{#each}` / `{:else if}` / …** — one placed between plain markup inside a `<div>` is a build error, not a lint warning. Transcript's per-block chips read `{@const chips = blockChips(m, p)}` inside the text branch's `{:else}` for that reason.
- **A literal `" - "` between template tags loses its leading space.** Svelte collapses whitespace-only text around inline tags, so `} - <span>` renders `msgs- 3K`. Write the separator as an expression — `{" - "}` — when it must survive in `textContent` (that is what the sidebar e2e assertions read).
- **Assert conditional classes with `classList`, never string matching**: Svelte's scope hash is emitted BETWEEN class names (`class="badge tok svelte-xyz big"`), so `html.includes('badge tok big')` fails on correct code. Prefer `querySelectorAll('.badge.tok.big')` plus a computed-style check when the colour is the point.
- **A block's token chips live inside `.body`.** `Transcript` renders `.blkstats` (and the thinking summary's chips) as part of the message body, so anything that reads message text out of `.body` (`innerText`, `textContent`) must strip `.blkstats` first or `endsWith(chunk)` fails on the trailing `≈35 tok` — see `stream-dup.test.mjs readAssistantText`.

- **Eager image decode**: corrupt image at prompt time → `session.error` + entire message dropped, nothing persists.
- `/permission` items have NO `title`, `pattern`, `path`, or `type` field. Use `patterns[0]` for file path, `metadata.input` for command.
- `POST /session/{id}/fork` takes undocumented `{messageID}` body — exclusive copy before that message.

### E2E tests

Authoring details (fake-engine server shape, seeding with `noReply:true`, `domcontentloaded` vs `networkidle`, Playwright install) live in **`e2e/README.md`** — read it before writing or debugging a test. The ones that bite hardest:

- Each test owns a unique PORT — check siblings before picking one.
- **`poll()` footgun**: `poll(() => el.count() === 0, T)` always times out — `count()` returns a Promise and `Promise === 0` is false. Always await: `poll(async () => (await el.count()) === 0, T)`.
- **Locator reads must `waitFor({state:'attached'})` before `textContent()`** — a bare `count()` races the history render and fails a check whose node exists 5 ms later.
- **A tool row's output box keys off `state.output`, never the tool name**, and mounts its body only while expanded (a `read` result can be 50 KB).
- **A dismiss assertion that resets the fake engine BEFORE the click proves nothing.** `compact-indicator` CASE F used to `ctl({status:{}})` and only then click ×, so an alert the client could never dismiss stayed green. Assert the dismissal while the record is STILL being served, over a window longer than the client's 10s status poll (`staysGone(page, sel, 12000)`), then show a NEWER record alerting again.

### Mobile

- Chrome Android ≥108: viewport meta must include `interactive-widget=resizes-content`.
- All `100vh` sites use an `@supports (height:100dvh)` guard — bare `var(--vvh,100dvh)` outside @supports breaks on engines without dvh.

### Streaming / rendering

- **Turn status is ONE slot: the Footer's `.status_indicator`** (variants `.thinking` / `.compacting`). The footer's three zones need **equal `flex: 1 1 0` shares on the side zones** — that is what keeps the middle dead-centre whatever the numbers read. The `@media (max-width:380px)` rule that drops the cylon **must sit after `.cmd`/`.cylon`** in the stylesheet: same specificity, an earlier copy silently loses. ComposerToolbar carries no status; the footer never prints the session's cwd. Transcript's `.cmpbox.running` is **telemetry-only**, so its sibling failure branch must exclude `state === 'running'` — otherwise a summary with no engine to ask renders "Compaction failed".
- **A compaction alert is dismissed CLIENT-side, and that is the only place it can be.** The bridge's `entry.compaction` is sticky on purpose (pi writes no transcript entry for a cancelled/failed summary, and its failure hook never leaves the extension runner), and the webui re-derives live state from `GET /session/status` — so `clearCompactionState()` alone is undone by the next poll. `stores.ts` keeps a per-session watermark of the dismissed record's `at` (`opencode.compactionDismissed` in localStorage) and `syncCompactionFromStatus` skips records at/below it. Never expire the bridge record instead, and do not add a server-side dismissal route: that is a two-repo contract for nothing.
- `headings=false` (user-role messages only — Transcript passes `m.role !== 'user'`): suppression MUST live in `renderer.heading`, never as a pre-escape regex — `\#` corrupts `# comments` inside ``` fences. Returning `false` from the override delegates to marked's default; `''` swallows the heading. Agent/reasoning/subagent text keeps full markdown.
- Delta coalescing in `sse.ts`: `message.part.delta` chunks buffered per key with ~40ms flush; `message.part.updated` snapshot ALWAYS drops buffered deltas first to prevent duplication.
- `scheduleRefetch()` gated on `!busy` in `message.updated` — otherwise in-progress thinking text gets overwritten by a stale engine snapshot.
