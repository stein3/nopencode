# /workspace/opencode — ttyd/webui stack

Facts about the opencode container stack in this directory. Multiple parallel workstreams live here — see the warning below.

## ⚠️ Parallel workstreams


## Deployment & ops

Deployment topology & procedures: see private ops notes (not tracked here).

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
