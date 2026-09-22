# E2E Tests

End-to-end tests for the opencode web UI. All current tests are **embedded**:
self-contained per-file tests that spin up their own Node HTTP server serving
`webui/dist` with stubbed `/oc/*` + `/api/history/*` endpoints and scripted SSE.
No live engine or chatserver is required.

> Integration tests (running against a real engine + chatserver) are not
> currently present. The `BASE_URL` / `ENGINE_URL` env vars and the
> engine-API notes in [Test-writing reference](#test-writing-reference) exist to
> support them when added.

## Prerequisites

- Node.js 18+
- Chromium (installed automatically by the setup steps below)

## Quick Start

```bash
# 1. Build the webui first — fake servers read webui/dist from disk.
#    A stale bundle silently tests stale code.
cd ../webui && npm run build

# 2. Install e2e dependencies (playwright-core)
cd e2e && npm ci

# 3. Install Chromium
npx playwright-core install chromium

# 4. Run ALL embedded tests serially
for t in embedded/*.test.mjs; do node "$t"; done
```

> **Run serially.** `node embedded/*.test.mjs` (the `npm run test:embedded`
> script) is misleading — Node only EXECUTES the first glob-expanded file and
> silently ignores the rest. Parallel batches (`xargs -P`) flake on fixed ports
> + headless Chromium contention. The `for` loop above runs every file, one at a
> time.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `WEBUI_DIST` | `../webui/dist` | Path to built webui dist |
| `CHROMIUM_PATH` | auto-detected | Explicit chromium executable path |
| `SHOTS_DIR` | `./shots` | Screenshot output directory (relative to `e2e/`) |
| `BASE_URL` | `http://127.0.0.1:8123` | Chatserver URL (integration tests) |
| `ENGINE_URL` | `http://127.0.0.1:4096` | Opencode engine URL (integration tests) |

## CI

GitHub Actions workflow at `.github/workflows/e2e.yml` runs as a **matrix with
one job per test file** (36 files). Each entry has a `name` and `file`:

```yaml
strategy:
  matrix:
    include:
      - name: question-picker
        file: question-picker.test.mjs
      - name: session-filters
        file: session-filters.test.mjs
      # ...
```

To add a new test: add a `- name:` / `file:` entry to the existing matrix. Do
**not** create a new workflow file. The `build` job builds `webui/dist` once and
uploads it as an artifact; each matrix job downloads it before running.

## Architecture

```
e2e/
├── embedded/           # Self-contained tests (own HTTP server, no engine)
│   ├── question-picker.test.mjs
│   ├── session-filters.test.mjs
│   ├── settings.test.mjs
│   ├── linked-sessions.test.mjs
│   ├── titleclip.test.mjs
│   ├── hidelight.test.mjs
│   ├── chords.test.mjs
│   ├── fork.test.mjs
│   ├── ... (~36 test files total; see .github/workflows/e2e.yml for the
│            canonical list of what CI runs)
│   └── nest.test.mjs.disabled   # skipped (not in matrix)
├── helpers/
│   └── setup.mjs       # Shared: env config, browser launch, fixtures
├── fixtures/           # fonts.conf, fonts/, libs/ for headless Chromium
├── lib/                # Additional shared utilities
├── utilities/          # Bench/debug tools (not test suites)
├── shots/              # Screenshot output (git-ignored)
└── package.json
```

Reference tests demonstrating the core patterns:
[`session-filters.test.mjs`](./embedded/session-filters.test.mjs),
[`settings.test.mjs`](./embedded/settings.test.mjs),
[`linked-sessions.test.mjs`](./embedded/linked-sessions.test.mjs).

## Adding a New Test

1. Create `your-test.test.mjs` in `embedded/`.
2. Import from `../helpers/setup.mjs`:
   ```js
   import { launchBrowser, seedSession, cleanup, createChecker, screenshot, sleep, poll } from '../helpers/setup.mjs'
   ```
3. Use `launchBrowser()` instead of a manual `chromium.launch` — it bakes in
   the software-rendering and font flags needed for headless Chromium (see
   [Browser launch](#browser-launch)).
4. **Pick a unique `PORT`** (the current range is 8127–8165; check sibling
   files for collisions first). Alternatively use `server.listen(0)` for an
   ephemeral port.
5. Use `seedSession(title, count)` to create fixture sessions via
   `noReply:true` POSTs.
6. Use `cleanup(sids)` in a `finally` block.
7. Use `createChecker()` for PASS/FAIL assertions.
8. Use `screenshot(page, name)` for captures (writes to `SHOTS_DIR`).
9. Add a `- name:` / `file:` entry to the matrix in
   `.github/workflows/e2e.yml`.

## Test-writing reference

Conventions and pitfalls learned from building the embedded suite. Reuse these
rather than rediscovering them.

### Build first

Fake servers serve `webui/dist` from disk. Always `cd webui && npm run build`
before running tests, or a stale bundle silently tests stale code.

### `/__state` + `/__ctl` convention

Fake servers expose two introspection/control endpoints:
- `GET /__state` — returns fixture state + request counts (assert against this,
  not UI internals, for deterministic checks).
- `POST /__ctl` — patch server status, fire SSE events via `sseEmit()`, etc.

Reference: any test using SSE fixtures (e.g. `engine-retry.test.mjs`,
`question-picker.test.mjs`).

### Browser launch

`launchBrowser()` in `e2e/helpers/setup.mjs` configures headless Chromium for
bare-metal / CI environments:

- `--use-gl=angle --use-angle=swiftshader` — forces software rendering.
  Without this, the chromium_headless_shell GPU subprocess hits an unimplemented
  fontconfig path and crashes (`SkFontMgr_FontConfigInterface.cpp:163 Not
  implemented`).
- Auto-detects the chromium_headless_shell binary under
  `~/.cache/ms-playwright/chromium_headless_shell-*`.
- Resolves `playwright-core` from the local `e2e/package.json`.

It also generates `fixtures/fonts.generated.conf` at runtime with **absolute
paths** derived from `WEBTEST_DIR`. fontconfig resolves `<dir>` relative to the
browser process CWD, not the config file, so relative paths crash when CWD ≠
`e2e/`. Reuse `setupFontEnv()`'s pattern if you need font config elsewhere.

### Navigation: `networkidle` never fires

`waitUntil: 'networkidle'` will hang — the SSE `/oc/event` connection stays
open indefinitely. Use `waitUntil: 'domcontentloaded'` + explicit UI waits
(`poll`, `expect(locator).toBeVisible()`, etc.).

### Mock-route gotchas

- A route handler that returns without calling `fulfill()`/`fallback()` **hangs**
  the request. This is useful for simulating the engine's blocking prompt POST,
  but remember to fulfill eventually.
- Route matching is **last-registered-wins**.
- The Playwright glob `**/oc/session/*/message` also matches the GET polling —
  filter with `route.request().method() === 'POST'` and call
  `route.fallback()` for the rest.
- Order matters *inside* one handler function: a `^/oc/session/[^/]+$` regex
  silently swallows `/oc/session/status` if checked first.

### Engine API traps

- **Engine rejects fake assistant messages** missing `parentID` or
  `time.created` when serving `/session/{id}/message`. If you inject messages
  directly in sqlite, include `parentID` (the user message they respond to) and
  `time: { created: <msEpoch> }`.
- **Engine API rejects `type: 'tool'` parts** (HTTP 400). Inject tool-card
  messages directly in sqlite instead of via `POST /session/{id}/message`.
- **`POST /session/{id}/message` with `noReply: true` + `parts`** creates a user
  message without running a turn — the cheap way to seed transcript fixtures.
- **`chatserver.py` `load_messages()` includes a `tokens` field** so the
  webui's `metricsFromMessages()` can populate InfoPanel metrics. Without it,
  the InfoPanel sees no token data.
- **Delete probe sessions afterward**: `DELETE /session/{id>` on the engine
  port (`ENGINE_URL`).

### Playwright scoping

Multiple mounted tab panes mean duplicate element IDs (`#composer-input` ×2 →
strict-mode violation). Scope locators to the active pane via
`.tabpane[style*="flex"]` or `:visible`.

### Transcript stick-to-bottom

Transcript pins to the bottom via a `stuck` flag. Programmatic
`scrollIntoView` does **not** clear `stuck`, so `follow()` re-pins to bottom
right after a manual scroll. In tests, clear it with a **real** wheel-up over
the pane:

```js
await page.mouse.move(cx, cy)
await page.mouse.wheel(0, -800)
```

### Freeze live churn after content renders

To get deterministic UI, route-abort the live-refresh requests (`/oc/event`,
`/oc/session/status`, `/session/*/message`). But only do this **after** the
fixture content has rendered — freezing earlier aborts the tab's windowed
message loads mid-flight ("no card rendered" flakes).

### Tall element screenshots

Element screenshots taller than the viewport go through CDP beyond-viewport
capture, where `content-visibility: auto` blanks offscreen `.msg` rows and the
sticky composer/status bar composite into the crop. Use a tall viewport
(e.g. 1900px) so the whole target is on-screen; guard that the box bottom sits
above the composer top.

### Store seeding (boot-initialized stores)

Stores like `sessionMeta` read `localStorage` **once at store creation**. A raw
`localStorage.setItem` afterward is invisible to a live store. Seed via
`page.evaluate(() => localStorage.setItem(...))` then `page.reload()`.

### Popovers / pickers

Popovers and pickers close on any outside click (`svelte:window on:click` +
`closest()`). Open one **immediately before** acting on it — don't assume it
survives unrelated clicks or sleeps.

### Debugging a 0-row filter assertion

A filter assertion returning unexpectedly 0 rows is usually a store state
problem, not a browser bug. Dump the store's `localStorage` via
`page.evaluate(() => localStorage.getItem('opencode.sessionMeta'))` before
suspecting the DOM.
