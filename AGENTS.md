# /workspace/opencode — ttyd/webui stack

Facts about the opencode container stack in this directory. Multiple parallel workstreams live here — see the warning below.

## ⚠️ Parallel workstreams


## Services & ports

| Container/service | Port | Purpose |
|---|---|---|
| `opencode-tui` (ttyd) | 7681 | Web terminal running opencode in tmux; HTML patched by `inject.py` |
| `opencode-engine` | 4096 (container-internal) | Headless `opencode serve`; reachable as `opencode-engine:4096` on the docker network |
| `opencode-web` | 7683 | Custom web UI: python3 `/app/chatserver.py`, serves `webui/dist`, proxies API calls to the engine |

## Common operations

- Rebuild/restart just the web UI after changes:
  ```sh
  sudo docker compose build opencode-web && sudo docker compose up -d --no-deps opencode-web
  ```
  (or `sudo docker compose up -d --build --no-deps opencode-web`)
- Engine not responding → sessions/messages 500: check `sudo docker compose logs opencode-engine` first.
- All container commands need `sudo` (sandbox user isn't in the docker group).
- TUI launch config lives in a mounted read-only `tmux.conf` (escape-time 0, allow-passthrough) rather than inline tmux commands.
- After editing `inject.py`: remove the cached `/app/index.html` and restart the TUI container (details in the ttyd-web-terminal skill).

## Known quirks

- Sessions created via the engine API don't appear in the TUI until refresh; cross-client live sync is not supported.
- `/workspace` inside the engine container must be the same worktree the TUI uses for session sharing.
- Stale "new session" tabs can 404 after engine restarts — delete them from the session list.

## Session diff data (webui DiffPane)

- Engine `/session/{id}/diff` returns `[]` for real sessions (snapshot store has no commits) — derive per-session changes from the transcript DB instead.
- `part` table: `type`/`tool` live inside the `data` JSON — filter with `json_extract(data,'$.type')`, order by `time_created`.
- Completed `edit` parts (100% coverage) carry a real per-edit unified patch at `state.metadata.filediff.patch` (+ `metadata.diff`) — no need to synthesize old/new pairs.
- `write` parts have only new content (`input.content`; `metadata.exists`=was-overwrite). `apply_patch` has `input.patchText` in `*** Begin Patch` V4A format (Add/Update/Delete File sections), not unified.
- `type:'patch'` parts are just `{hash, files}` bookkeeping — ignore.
- chatserver.py already routes `/api/history/session/{id}/changes` → `session_changes(sid)` (uncommitted), but the function is not yet implemented → 500s today.
- Gotcha: `applyPatchReverse()` in webui/src/lib/diffs.ts `break`s on non-hunk lines, so it only handles a single patch's hunks — loop it per-op when reverse-applying multiple patches; don't concatenate raw patch texts.
