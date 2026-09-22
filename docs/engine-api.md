# Engine API reference

Verified against **opencode-ai v1.18.18** via live engine probe, OpenAPI
`/doc`, and binary inspection. The engine's own `/doc` endpoint on a running
instance (`opencode serve --port <p>` then `curl /doc`) is the schema source of
for anything not listed here.

**Version coupling**: these shapes are pinned to v1.18.18. A version bump can
change field names, add/remove endpoints, or alter semantics — re-verify against
`/doc` before relying on anything below.

**Two route trees**: the engine exposes a **legacy** `/session/*` tree and a
**v2** `/api/session/*` tree. They are NOT interchangeable — each endpoint below
notes which tree it belongs to. The v2 tree is the one the webui prefers for
mutations (model/agent switches); reads and prompt sends still use legacy routes.

---

## Prompt / message sending

### `POST /session/{id}/prompt_async` (legacy tree) — async prompt

- Returns **204 No Content** within milliseconds. The turn streams in over SSE
  (`message.*`, `session.idle`/`session.error`). Clients must drive UI from SSE,
  not the response body.
- Body mirrors the sync `/message` endpoint:
  - `parts: [{type:'text', text}, ...]` — text part first, optional file parts
    after.
  - `model: {providerID, modelID}` — explicit per-turn model override; omitted =
    session default. (`modelID` here, NOT `id`; see Model selection.)
  - `agent: string` — top-level body field, runs this one turn under the named
    agent; omitted = session default.
- **Eager image decode**: the engine decodes image parts at prompt time. A
  corrupt/undecodable image → `ImageDecodeError` → `session.error`, and the
  **entire message (text included) is dropped** — nothing persists. The 204 still
  returns, so this failure mode surfaces only via SSE.
- **No async `/command` variant** exists — `POST /session/{id}/command` is
  synchronous and blocks until completion. Long slash commands can hit edge
  timeouts (e.g. Cloudflare ~100 s).

### `POST /session/{id}/message` (legacy tree) — sync message

- Blocking alternative to `prompt_async`; the request holds the connection open
  until the turn finishes.
- Body accepts the same `parts`, `model: {providerID, modelID}`, and `agent`
  fields as `prompt_async`.
- **Busy-queue behavior**: POSTing while the session is already busy does NOT
  error. The engine queues the turn and the request blocks until it completes —
  back-to-back sends return in order.
- **`noReply` flag**: `{"noReply": true, parts:[…]}` creates a user message
  WITHOUT running a turn — the cheap way to seed transcript fixtures. **Image
  file parts are rejected (400) under `noReply`**; only `text/plain` rides it.
  Images persist only via `prompt_async`.

---

## Permissions

### `GET /permission` + SSE `permission.asked` (legacy tree)

Items and the SSE payload share this shape (there is **no** `title`, `pattern`,
`path`, or `type` field — these were a common earlier guess):

```
{id, sessionID, permission, patterns[], metadata{}, always[], tool?{messageID, callID}}
```

- `permission` is the kind: `bash`, `edit`, `read`, `glob`, `grep`, `webfetch`,
  `doom_loop`, …
- `metadata.input` holds the tool-call input for bash (show `input.command`);
  glob/grep → `{pattern, path}`; webfetch → `{url}`; mcp reads → `{server}`.
- Edit asks carry the file path in `patterns[0]`.

### `POST /permission/{id}/reply` (legacy tree)

Body `{reply: 'once' | 'always' | 'reject'}`.

---

## Questions

### `GET /question` + SSE `question.asked` (legacy tree)

Returns pending requests across all sessions:

```
[{id, sessionID, questions:[{question, header, options:[{label, description}], multiple?, custom?}], tool:{messageID, callID}}]
```

- `question.asked` fires **exactly once** per request — no heartbeat/re-ask. SSE
  reconnect does NOT replay pending questions; clients must re-`GET /question`.
- Session stays `busy` while a question pends.
- Reply validation is lax: outer `answers` length is NOT checked vs question
  count (missing → "Unanswered"), empty inner arrays allowed, unknown/already-
  answered id → 404 `QuestionNotFoundError`.
- Events broadcast to ALL connected clients; first reply wins, second gets 404.
- Registry is **in-memory per instance** — lost on engine restart.

### `POST /question/{id}/reply` / `POST /question/{id}/reject` (legacy tree)

Reply body `{answers: string[][]}` — one label array **per question** (array even
for single-answer questions). Reject body `{}`. SSE events: `question.replied` /
`question.rejected` (plus `.v2` variants).

---

## Model selection

### Create-time model — `POST /session` (legacy tree)

Body accepts `model: {providerID, id}`. A session created without one inherits
the config default; the first turn then ignores a per-message model pick.

### Per-message model override

Both `POST /session/{id}/prompt_async` and `POST /session/{id}/message` accept
`model: {providerID, modelID}` (**`modelID`**, not `id`). Explicit model wins and
is stamped on the echoed user message AND updates `session.model` — even with
`noReply: true`.

### Switch current session's model — `POST /api/session/{id}/model` (**v2 tree only**)

Body `{model: {providerID, id}}` (ModelRef uses **`id`**, not `modelID`). There
is **no** `/session/{id}/model` in the legacy tree. Returns 415 without
`content-type: application/json`.

### Message model-id data shapes (stored)

- Assistant messages store **flat** `data.modelID` + `data.providerID`.
- User messages store **nested** `data.model = {providerID, modelID}` and **no**
  flat `modelID`.

---

## Agents (per-message role)

### Roster — `GET /oc/agent` (legacy tree)

Returns the **merged** registry: built-ins + user config (`agent` key in
`opencode.json`, `~/.config/opencode/{agent,agents}/**/*.md`, project
`.opencode/…`) + plugin-config agents. Includes hidden/system entries
(`compaction`/`title`/`summary`) and subagents — consumers filter
`mode !== 'subagent' && !hidden`. Order: configured/default first, then
alphabetical.

Built-in roster is version-dependent: 1.18.18 ships only `build`/`plan` (plus the
hidden system trio). Plugins have no classic register-agent hook; config/plugin
agents converge into the same registry.

### Per-message role

Top-level `agent: string` in the body of `POST /session/{id}`/`prompt_async`/
`message`/`command`. Omit = session default (usually `build`). Every stored
message carries `data.agent` on both user and assistant turns.

### Session-level default switch — `POST /api/session/{id}/agent` (**v2 tree only**)

Body `{agent: string}`. Emits agent-switched events.

---

## Session fork — `POST /session/{id}/fork` (legacy tree)

Undocumented JSON body `{messageID}` (OpenAPI `/doc` omits it; empty/absent =
whole-session copy).

- New session is **standalone** (no `parentID`).
- Copies messages **strictly BEFORE** the messageID (exclusive — TUI "Fork from
  message" parity). Unknown messageID degrades to full copy.
- Message/part ids remapped; compaction `tail_start_id` remapped; metadata
  cloned; revert state NOT copied; source untouched.
- Engine emits `session.forked` SSE and **titles the fork itself** (`"<source>
  (fork #N)"`).

---

## Retry / status

### Retry-loop state (provider limit errors)

Provider limit errors (e.g. "Free usage exceeded…") do NOT surface as a final
error: the engine's internal retry policy keeps the turn RUNNING and sets session
status:

```
{type:"retry", attempt, message, action:{reason, provider, title, label, link}, next}
```

`next` = epoch ms of next attempt; delay honors `retry-after` headers (can be
hours); max 5 attempts, then a final error lands on the message. While retrying:
NO `session.error`, NO `session.idle`; the in-flight assistant message has empty
parts and no `error` field.

- Exposed **only** by: (a) ephemeral `session.status` SSE event fired per attempt
  (NOT replayed — a tab opened mid-stall sees nothing), and (b) poll-able
  `GET /session/status` snapshot (in-memory map).
- `GET /session/status` returns `Record<sessionID, {type, attempt, message,
  action, next}>`.

### Recovery

- `POST /session/{id}/abort` — interrupts the retry fiber → assistant message
  finalized with AbortError, user message kept, session idles. **No busy guard.**
- `POST /session/{id}/revert` `{messageID, partID?}` — enforces `assertNotBusy` →
  **409 `{name:"SessionBusyError", data:{sessionID, message}}`** while the retry
  loop is live. Same busy guard on unrevert/shell/DELETE message; `/abort` and
  `/fork` have none.
- The abort HTTP response returns only after server-side finalizers run, so an
  awaited `abort()` guarantees a following `revert()` passes `assertNotBusy`.

---

## Token & context accounting

- **Aborted turns, step-start/step-finish-only turns, and provider-silent
  responses** permanently leave an **all-zero `tokens` object** on the newest
  assistant message. An all-zero object is truthy — naive "newest assistant
  message wins" logic reads it as 0 context. Treat an all-zero tally as
  "unknown", not zero.
- **Session-level `tokens`** on `GET /session/{id}` are **cumulative all-turn
  totals** (cache.read in the millions), **NOT** context size. Never use them for
  a "% used" meter. Per-turn context must be derived from individual message
  tallies.
