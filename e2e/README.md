# E2E Tests

End-to-end tests for the opencode web UI. Two categories:

- **Embedded tests** — self-contained, no engine needed. Spin up their own HTTP server with stubbed API endpoints and scripted SSE.
- **Integration tests** — need a running opencode engine (`:4096`) and chatserver (`:8123`). Test the full stack against real API responses and SQLite.

## Prerequisites

- Node.js 18+
- Python 3.10+ (integration tests only)
- `opencode-ai` npm package (integration tests only): `npm install -g opencode-ai@1.18.18`

## Quick Start

```bash
# Install dependencies
cd e2e && npm ci

# Install Chromium for playwright-core
npx playwright install --with-deps chromium

# Run embedded tests (no engine needed)
node embedded/*.test.mjs
```

## Running Integration Tests

```bash
# Terminal 1: start the engine (no API keys needed for noReply-only tests)
opencode serve --port 4096

# Terminal 2: start chatserver
OC_ENGINE=http://127.0.0.1:4096 PORT=8123 HOST=127.0.0.1 python3 chatserver.py

# Terminal 3: run tests
node integration/*.test.mjs
```

Or build the webui first (required for chatserver to serve assets):

```bash
cd ../webui && npm ci && npm run build
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `BASE_URL` | `http://127.0.0.1:8123` | Chatserver URL |
| `ENGINE_URL` | `http://127.0.0.1:4096` | Opencode engine URL |
| `WEBUI_DIST` | `../webui/dist` | Path to built webui dist |
| `CHROMIUM_PATH` | auto-detected | Explicit chromium executable path |
| `SHOTS_DIR` | `./shots` | Screenshot output directory |

## CI

GitHub Actions workflow at `.github/workflows/e2e.yml` runs two parallel jobs:

1. **Embedded** — ~30s, no infrastructure needed
2. **Integration** — ~90s, installs engine + builds webui + starts services

## Architecture

```
e2e/
├── embedded/           # Self-contained tests (own HTTP server, no engine)
│   ├── question-picker.test.mjs
│   ├── hidelight.test.mjs
│   ├── linked-sessions.test.mjs
│   ├── titleclip.test.mjs
│   ├── errtile-render.test.mjs
│   ├── imgthumb.test.mjs
│   └── queue-fix.test.mjs
├── integration/        # Live-engine tests (need engine + chatserver)
│   ├── hotkeys.test.mjs
│   ├── agent-picker.test.mjs
│   ├── model-picker.test.mjs
│   └── ... (24 files)
├── helpers/
│   └── setup.mjs       # Shared: env config, browser launch, fixtures
├── utilities/          # Bench/debug tools (not test suites)
│   ├── fake-engine.py  # Embedded fake engine for retry testing
│   ├── bench.mjs
│   └── ...
├── fixtures/           # fonts.conf, fonts/, libs/ for headless Chromium
└── package.json
```

## Adding a New Test

1. Create `your-test.test.mjs` in `embedded/` or `integration/`
2. Import from `../helpers/setup.mjs`:
   ```js
   import { BASE, ENGINE, launchBrowser, seedSession, cleanup, createChecker, screenshot } from '../helpers/setup.mjs'
   ```
3. Use `launchBrowser()` instead of manual chromium.launch
4. Use `seedSession(title, count)` to create fixture sessions
5. Use `cleanup(sids)` in finally blocks
6. Use `createChecker()` for PASS/FAIL assertions
7. Use `screenshot(page, name)` for captures
