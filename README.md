# nopencode

A self-hosted, fully containerized stack for running [opencode](https://github.com/opencode-ai/opencode) — the open-source AI coding agent — in a browser, with a custom web chat UI alongside the stock terminal interface, both accessible remotely via a web browser.

The main goal of the project is to host opencode on a home server and be able to use it remotely from desktop, phone, and tablet.

Three services, one image:

| Service | Port | What it runs |
|---|---|---|
| `opencode-tui` | `7681` | The stock opencode TUI served over the web via [ttyd](https://github.com/tsl0922/ttyd) + tmux |
| `opencode-engine` | `7682` | Headless `opencode serve` exposing the agent's REST + SSE API |
| `opencode-web` | `7683` | A custom web UI (`webui/`) served by a small Python backend |

The TUI and the web UI are two frontends onto the same opencode instance: both containers share the same config and session-store volumes, and the TUI attaches to the shared headless engine (`opencode attach`) when it is up.

## Architecture

```
browser ──► opencode-tui :7681     ttyd → tmux → opencode TUI
                                   └─ attach http://opencode-engine:4096
browser ──► opencode-web :7683     chatserver.py (serves webui/dist,
                                   │            read-only SQLite history + search)
                                   └─ /oc/* reverse proxy ──┐
browser ─► opencode-engine :7682   opencode serve ◄─────────┘   (REST + SSE)
```

### Components

**`chatserver.py`** — single-origin backend for the web UI, pure Python standard library (no dependencies):

- `/` — serves the built `webui/dist` SPA (ETag revalidation, immutable hashed assets, transparent `.br`/`.gz` precompressed serving)
- `/oc/*` — streaming reverse proxy for the engine's REST + SSE traffic
- `/api/history/*` — read-only SQL against opencode's own SQLite database (`opencode.db` is opened `mode=ro` + `query_only`; WAL-safe alongside a live engine/TUI): session list, transcript windows, full-text search
- `/api/history/session/{id}/errors` — persists turn-failure tiles in a tiny sidecar database (`webui.db`), the only record of errors the engine does not store
- `/healthz` — liveness

**`inject.py`** — post-processes the page served by ttyd to make the terminal usable from phones/tablets: mobile viewport fixes, OSC 52 clipboard support, and an on-screen modifier/function-key bar.

**`webui/`** — the custom frontend: Svelte 4 + Vite 5 + TypeScript, with marked/DOMPurify/highlight.js for streaming-safe markdown and Monaco for diffs.

## Web UI features

- Multi-tab sessions with live streaming over SSE
- Streaming markdown rendering with syntax highlighting (throttled/coalesced so long turns stay cheap)
- Session sidebar with status lights (busy / unread / permission / question), nested subagent sessions, and full-text search across all message parts
- Model picker (with recents) and per-session agent picker
- Command palette + composer slash commands + ctrl+x leader chords, mirroring the TUI's command set
- Permission-request prompts and an interactive picker for the question tool
- Per-session diff viewer (Monaco) reconstructed from transcript edits/writes
- Token/context usage tracking per session
- Automatic retry with backoff for retryable provider failures
- Turn-failure tiles (persisted), abort rendering, fork-from-any-message, transcript export/copy, windowed loading of very long histories
- Mobile-friendly layout (visualViewport-aware keyboard handling)

## Quick start

Prerequisites: Docker with Compose v2.

```bash
git clone https://github.com/stein3/nopencode.git
cd nopencode
cp .env.example .env
# edit .env: provider API key(s) + HOST_WORKSPACE
docker compose up --build -d
```

Then open:

- `http://localhost:7683` — web UI
- `http://localhost:7681` — terminal TUI in the browser
- `http://localhost:7682` — engine HTTP API directly (optional)

## Configuration

`.env` (consumed by Compose):

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Passed into the TUI/engine containers for Anthropic models |
| `OPENAI_API_KEY` | Passed into the TUI/engine containers for OpenAI models |
| `HOST_WORKSPACE` | Host directory mounted at `/workspace` inside the TUI/engine containers (the agent's working directory) |

`chatserver.py` environment (defaults shown; Compose sets `PORT` and `OC_ENGINE` for you):

| Variable | Default |
|---|---|
| `PORT` | `8080` |
| `HOST` | `0.0.0.0` |
| `OC_ENGINE` | `http://127.0.0.1:4096` |
| `OC_DB` | `~/.local/share/opencode/opencode.db` |
| `OC_WEBUI_DB` | `<dir of OC_DB>/webui.db` |
| `WEBUI_DIST` | `./webui/dist` |

### Version pinning

The Dockerfile pins `opencode-ai@1.18.18` and `ttyd@1.7.7`. The serve API surface the web UI talks to is version-coupled to the engine — bump deliberately and expect to update the frontend together.

## Security

> **There is no authentication on any service.** The stack is designed to run on a private, trusted network. Do not port-forward any of these ports directly to the internet; if you need remote access, put your own authenticating reverse proxy in front.

The web backend additionally opens the agent's database strictly read-only, and the only thing it ever writes is its own small sidecar file next to it.

## Development

Build and iterate on the web UI without Docker:

```bash
cd webui
npm ci
npm run dev      # vite dev server
npm run build    # emits dist/ + precompressed .br/.gz siblings (scripts/compress.mjs)
```

`webui/dist` is not committed to the repository — the Dockerfile builds it in a first-stage Node build and copies only the output into the final image, so `docker compose up --build` always ships a fresh frontend.

Run the backend standalone against a locally running engine:

```bash
OC_ENGINE=127.0.0.1:4096 PORT=8080 python3 chatserver.py
```

Notes:

- `start.sh` caches the patched terminal page (`/app/index.html`) generated once by `inject.py` at first boot; after editing `inject.py`, rebuild the image so the cache is regenerated.
- The engine's API shape is discoverable from a running instance via its OpenAPI document at `/doc`.

## Repository layout

```
.
├── compose.yaml           # three services, shared volumes, resource limits
├── Dockerfile             # multi-stage: builds webui, installs pinned ttyd + opencode
├── start.sh               # ttyd launcher (caches the injected terminal page)
├── inject.py              # patches ttyd's page: viewport, OSC 52 clipboard, mobile key bar
├── chatserver.py          # stdlib backend: statics + engine proxy + read-only SQLite APIs
└── webui/
    ├── src/
    └── scripts/compress.mjs
```

## Acknowledgments

Built on top of:

- [opencode](https://github.com/opencode-ai/opencode) — the AI coding agent this stack hosts ([docs](https://opencode.ai))
- [ttyd](https://github.com/tsl0922/ttyd) — terminal-over-browser gateway

This project is independent and not affiliated with the upstream opencode project.
