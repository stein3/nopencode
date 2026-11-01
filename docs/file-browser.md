# File Browser + per-message diffs (design)

Status: **design → implementation**. Scope agreed up front:

1. **Coexist** with the existing diff pane — nothing is deleted. The file browser
   is a new right drawer; the diff pane keeps its Monaco and its two modes.
2. "Changes" means the **revert-aware / per-message** flavour: the diff a *given
   tool call* made, straight off the transcript — not the live worktree, not a
   merged per-session tally.
3. **Read-only.** No write, no delete, no `/api/open`.
4. **Search: filenames only**, never contents.
5. **As live as it's cheap to be** — derived from frames already on the wire, no
   filesystem watcher, no polling.
6. **Dirty state and diffs come from git** in the file browser — and that is
   *separate* from the existing diff pane. Making the transcript's diff view
   smarter is **follow-up work** (§9): nothing in this design changes what
   `DiffPane` does today beyond adding a read-only single-model mode.

## Why not import tau's file browser

`pi-tau-web-server@1.1.8` `public/file-browser.ts` is 196 lines of imperative DOM:
flat one-directory listing, emoji icons, click = splice a path into a `<textarea>`,
dblclick = `POST /api/open` (spawns an OS opener — meaningless in a container).
It is unthemed, has no tree, no preview, no search. Vendoring the package into the
opencode stack would drag in ~3.1k lines of a server that owns its own session
manager, websocket protocol and auth.

What **is** worth porting is the ~60 lines of server policy, which has security
teeth and has already had thought spent on it:

- `IGNORED_NAMES` and the dotfile rule (hide dotfiles **except** `.env`),
- directory-first then `localeCompare` sort,
- size formatting,
- and the containment algorithm: resolve against the **session's cwd**,
  `realpathSync` both sides, reject symlink escapes.

The webui side is a rebuild in Svelte. The pi-web side is ~80 lines of bridge.

## 1. Shared endpoint contract

Both backends answer the same three routes. Names live under `/oc/fs/*` so the
existing proxy rules carry them: `chatserver.py` forwards every `/oc/*` to the
engine but **special-cases** `/oc/workspaces` and `/oc/fs/dirs` locally — `/oc/fs/*`
is a fourth local route, because the opencode engine serves none of these
(verified: only `/oc/vcs/diff`, `/oc/vcs/diff/raw` and `/oc/file/content` exist).

```
GET /oc/fs/list?cwd=<sessionCwd>&path=<rel|abs>
    -> { root, path, at, truncated, items: [
         { name, path, isDirectory, size, mtime } ] }

GET /oc/fs/file?cwd=<sessionCwd>&path=<rel|abs>
    -> { path, type: 'text'|'binary'|'image'|'too_large',
         content?, base64?, mime?, size, truncated }

GET /oc/fs/find?cwd=<sessionCwd>&q=<substring>
    -> { root, matches: [{ path, name, isDirectory }], truncated }

GET /oc/fs/status?cwd=<sessionCwd>
    -> { root, repo, toplevel?, head?, branch?, dirty: [{ path, abs, status }],
         scoped?, omitted?, truncated, error? }

GET /oc/fs/diff?cwd=<sessionCwd>&path=<rel|abs>
    -> { root, toplevel, path, rel, patch, truncated, untracked }
```

Both are implemented: `pi-web.mjs` (the `FS_ROUTES` block) and `chatserver.py`
(same contract, same field names — the drawer is ONE component talking to two
backends, so the shapes are not negotiable).

`cwd` is the **session's** directory, not a global root: pi-web's sessions are
per-directory, so the root must follow the tab.

### Rules (identical in both implementations)

- **Root** = the `cwd` param, validated to be an existing directory.
  On pi-web the caller passes what `liveCwd()` returns, i.e. the transcript
  header's cwd **only if it still exists**, else the nearest existing ancestor,
  else `PI_CWD` — never a header cwd straight from the JSONL, and never `/`.
  On the opencode side the caller passes the session's `directory`, falling back
  to `workspace_root()`.
- **Ceiling**: navigation may go *up* from a session root, but never above the
  workspace ceiling — `/workspace/` (`WORKTREE`) on the opencode side, `PI_CWD`
  on pi-web. Above the ceiling ⇒ 403 with the ceiling quoted in the message.
  The ceiling is never `/`.
- **Symlinks**: `realpathSync` the target; if the resolved path escapes the
  ceiling, 403. (tau's rule, ported.) A link that escapes is still LISTED, with
  `escapes:true`, so the drawer can grey it out — a missing row reads as "there
  is no such file", a greyed row reads as "you may not read this one". `find`
  searches a link's NAME but never walks through one.
- **A repo may reach ABOVE the ceiling** (`--cwd` one level inside it, the
  ordinary shape of a session started in a subdir). Then `status` still reports
  `repo:true` + `toplevel`, but the dirty set is CUT at the ceiling and the
  answer says so (`scoped:true, omitted:N`). Naming files this server is
  forbidden to read would leak exactly what the containment rule exists to hide.
- **Ignore set** for both list and find: `node_modules`, `.git`, `__pycache__`,
  `.next`, `.nuxt`, `dist`, `build`, `.cache`, `.turbo`, `venv`, `.venv`, `env`,
  `coverage`, `.nyc_output`, `.parcel-cache`, `.pytest_cache`, `.pi`,
  `.DS_Store`, `.Trash`, `target`, plus `.env.local`. Dotfiles are hidden except
  `.env` (tau's rule — `.env` stays visible because reading it is the common
  reason to open a drawer).
- **Caps**: 500 entries per directory, 200 find matches, 1 MiB into the text
  viewer (`truncated:true` + `size` beyond that), NUL byte ⇒ `binary`.
  Never follow into a directory during `find` past a depth of 12. The
  `git status` cap (20 000 by default) is env-overridable —
  `PI_WEB_FS_STATUS_CAP` / `OC_FS_STATUS_CAP` — so a check can prove the refusal
  without seeding 20k files. Over the cap the route REFUSES rather than
  truncating: a partial dirty set silently un-badges files.
- **A 404 on `/oc/fs/*` is the capability probe**, same trick as the queue shape
  in `api.ts`: a backend that has not shipped these routes degrades to "no file
  browser", it does not render an error drawer.
- **Never** route the browser through `/oc/file/content`: that route takes an
  arbitrary absolute path with **no containment at all** (it exists because the
  diff pane needs the live before-image of a file the session already named).
  The browser gets its own guarded route. Hardening `/file/content` itself is a
  separate, later change — it would be a behaviour change for the diff pane.

## 2. Webui shape

Three right drawers already coexist (`$infoOpen`, `diffOpen`, MCP). A fourth
independent drawer on a phone is unusable, so the file browser and the diff pane
become **one drawer with a segmented control**, and the existing diff toggle
keeps working exactly as it does today:

```
[ Files | Changes ]                     ← segmented control in the drawer head
```

- `Ctrl+D` (existing `toggleDiff`, `hotkeys.ts`) → opens the drawer on
  **Changes**, unchanged behaviour; `ctrl+x d` does the same as a chord.
- **`ctrl+x f`** → opens **Files** (`f: 'files'` added to `CHORD_HINTS`, so
  which-key advertises it), plus a folder button in the topbar. Not `Ctrl+E`:
  every direct Ctrl-letter risks shadowing a browser or editor binding, and the
  leader is already the app's own namespace.
- `/files` and `/changes` in `lib/commands.ts`, so the palette and the composer's
  `/` menu both reach the drawer. `/diff` (the raw worktree dump) is untouched —
  different question, kept.
- `use:sidePanel` keeps owning *close*; the window-level edge-*open* handler in
  `App.svelte` gains the new drawer alongside `$infoOpen`.

New files:

| file | role |
|---|---|
| `webui/src/lib/fs.ts` | the five routes + module-level caches with a generation counter (same discipline as `diffs.ts`), plus the `FsUnsupported` capability probe |
| `webui/src/lib/changes.ts` | the per-call projection (§3) + `shellMutationHint` + path matching |
| `webui/src/lib/monaco.ts` | ONE Monaco setup (worker, codicon font, the two themes, ext→language) shared by both panes |
| `webui/src/components/FileBrowser.svelte` | the Files tab: head (branch + dirty count), find box, tree, viewer |
| `webui/src/components/FileTree.svelte` | recursive via `svelte:self`, one `/fs/list` per EXPANDED dir, badges, roll-up counts on collapsed dirs |
| `webui/src/components/FileViewer.svelte` | the viewer: `file` (single read-only model) or `diff` (`createDiffEditor`), plus image / `binary` / `too_large` notices |
| `webui/src/lib/changes.test.ts` | 10 unit tests for the projection (§6) |

**Deviation from the first draft:** the plan was to give `DiffPane` a
`mode: 'diff' | 'file'`. What shipped is a separate `FileViewer` plus a shared
`lib/monaco.ts` — the reuse payoff (themes, worker, codicons, `langOf`, lazy
import) is identical, and the panes stop sharing one component that would then
mean two different things by "the diff". `DiffPane` gained only a `tab` prop and
the §3b hint line.

Reusing the diff pane's Monaco is the whole payoff: themes (`oc-dark`/`oc-light`
and the 4 light themes), `langOf`, the codicon css alias, `ResizeObserver`
layout, lazy import — all already solved there.

### Git is the dirty indicator (and it is not the diff pane)

The Files tab asks git, once per drawer open (and on `↻`, and when a turn ends):

```
git -C <sessionCwd> rev-parse --show-toplevel     # repo? head? branch?
git -C <sessionCwd> status --porcelain=v1 -z --untracked-files=all
git -C <toplevel> diff --no-color -U3 HEAD -- <rel>   # per selected path
```

Three details that are not decoration:

- **`HEAD`, not the index.** Plain `git diff` compares worktree to index, so an
  edit somebody already staged answers an EMPTY patch for a file the drawer just
  badged as dirty. `git diff HEAD` covers staged and unstaged alike (pinned by
  both backend checks with a deliberately staged edit).
- **`GIT_OPTIONAL_LOCKS=0`.** Plain `git status` REFRESHES the index and writes
  `.git/index` — in a worktree another agent is editing, that is a write, and
  this drawer's contract is read-only.
- **One word per badge.** porcelain `M ` (staged) and ` M` (worktree) collapse to
  `modified`; the drawer badges "dirty", and whether the change happens to be
  staged is somebody else's business here. Untracked → synthesized all-adds;
  deleted → all-removes against HEAD.

- Tree rows get `●` (modified) / `+` (untracked) / `✗` (deleted) / `↻` (renamed),
  and directories roll the badge up so a collapsed subtree still shows it.
- Selecting a dirty file shows **`git diff` for that path** in a second viewer
  instance — `createDiffEditor()`, fed by `git diff --no-color -U3 HEAD -- <path>` (untracked ⇒
  all-adds from the file content, deleted ⇒ all-removes from `git show HEAD:<path>`).
- **This is deliberately a separate component from `DiffPane`.** `DiffPane` is the
  transcript/worktree pane `Ctrl+D` opens; the browser's git view is scoped to the
  repo at the drawer's root and to the file the tree has selected. Sharing one
  component would couple two different notions of "the diff" (see §9).
- `/oc/fs/status` is **not** `/oc/vcs/diff`. pi-web answers `/oc/vcs/diff*` with
  `EMPTY_VCS` (`pi-web.mjs:2437`) by design — the DiffPane is unwired there, and
  node has no `spawn`-free git. The browser's status comes from its own route.
- Cost: one `status` per open, capped (refuse above ~20k entries rather than
  attempting it), plus a per-path `git diff` on selection only. Never a watcher,
  never a poll loop; the drawer's `↻` is the refresh.
- Not-a-repo ⇒ `{ repo: false }` and the Files tab just shows a plain tree with
  mtime sort. No error tile.
- **Safety**: read-only git only (`rev-parse`, `status`, `diff`, `show`). Never
  `add`, `stash`, `checkout`, `restore` — the worktree here is shared and
  routinely carries another agent's in-flight edits.

Click behaviour, deliberately **not** tau's:

- single click on a file → view it (read-only Monaco, or the image preview via
  `/oc/fs/file`); if the file is dirty, the viewer opens on its **git diff**
  instead, with a `file | diff` switch in the viewer head,
- `@` button on the row → stage it through `lib/attachments.ts` (images and text
  both work; the composer already inlines text/code for the model),
- drag → same as `@` (drop target is the composer, like tau),
- double-click on a **directory** → expand; on a file → nothing special.

No `/api/open`, no path-splicing into the textarea.

## 3. Changes tab = per-message diffs, zero new endpoints

This is the part that needs no backend at all, because both stacks already ship
the patch on the tool part:

- **pi**: `toolMetadata()` in `web/pi-web.mjs` copies `result.details.patch` into
  `state.metadata.filediff.patch` (+ `diff`, + `additions`/`deletions`,
  `firstChangedLine`) on **every** frame for that part — live
  `tool_execution_end` and the cold history projection alike.
- **opencode**: the engine's own edit parts carry `state.metadata.filediff.patch`,
  with `state.metadata.diff` as the documented fallback.
- The webui already knows how to read it: `patchTextOf()` in `Transcript.svelte`
  (`filediff.patch || diff`, else synthesise all-adds from `state.input.content`
  for `write`).

So the Changes tab is a **client-side projection of `tab.messages`** — no fetch:

```ts
// webui/src/lib/changes.ts
export function sessionChanges(tab: Tab): ChangeRow[]
// walks messages in transcript order, keeps parts where
// type==='tool' && EDITISH.test(tool) && (patch || input.content),
// reusing patchTextOf()'s rules, and returns
// { msgId, partId, tool, file, patch, additions, deletions, at, status }
```

Why this is the right "changes" for a **revert-aware** UI: it is keyed by
message/part, and the tab's `messages` are already the root→leaf chain — pi-web
seeds a resumed child with `leafChain(readJsonl(file))`, and tau replaces its
mirror after a navigation. So after a revert the reverted branch's edits are
simply not in the list. A merged per-session patch (what `chatserver.py`'s
`session_changes` + `diffs.ts` `mergePatches` do) cannot say that: it flattens
history and renumbers every hunk to `@@ -1,N +1,M @@`.

Two consequences to accept, both honest:

- **Ordering is transcript order, and each row is its own diff.** Clicking a row
  shows *that call's* diff, not the cumulative file state. That is what "which
  message did what" means, and it is exactly what the current merged pane throws
  away.
- **`write` overwrites still have no before-image** on either backend (opencode
  records `metadata.exists` and drops the patch; pi's `write` details have no
  pre-image either). Those rows render as "replaced, pre-image not recoverable"
  rather than being silently filtered out — which is what the merged pane does
  today (`toDiffFiles` drops anything with no patch).

The existing merged pane stays reachable as the **Worktree** mode of the Changes
tab (the current `wtMode` toggle, `/oc/vcs/diff?mode=git`, opencode only). So the
Changes tab has three sources: `Session (per call)` — default, both backends ·
`Worktree` — opencode only, hidden on pi-web · and Files shows plain content.

## 3b. Out of band edits: python / sed / patch (diagnosis now, fix later)

The Changes tab above sees only what the tools report, and that is a real hole:

- **pi**: `bash` details are `{truncation:{content}, fullOutputPath}` and **never
  carry a patch** — only `edit` sets `details.patch`, so `toolMetadata()` returns
  `{}` for bash by design. A `python3 - <<EOF` or `sed -i` fix produces a tool
  row with no diff at all.
- **opencode**: `chatserver.py`'s `session_changes` filters to
  `tool IN ('edit','write','apply_patch')`, so out-of-band writes are not merely
  undiffed — they are not in the payload.

This is not hypothetical: the fixes in this repo's own history were frequently
made through `python`/`sed` in bash. So the honest statement of scope is:

- **Now**: the Changes tab reports *tool-reported* edits, and the row must say so
  when the session also ran write-looking shell commands — a
  `⚠ N shell commands may have changed files` line computed from the same
  `tab.messages` projection (regex on the bash `input.command`: `>`, `>>`, `tee`,
  `sed -i`, `perl -pi`, `python`, `patch`, `apply_patch`, `truncate`, `mv`, `cp`,
  `rm`, `dd`, `make`, `cargo`, `npm`). It is a hint, not a claim, and it must not
  pretend to be a diff.
- **Also now, for free**: git covers out-of-band edits at the **repo** level, not
  the message level — that is exactly what §2's `/oc/fs/status` + `git diff` gives
  us, with no capture machinery and no index risk.
- **Later (§9)**: message-level attribution for out-of-band edits. Three candidate
  mechanisms, all rejected for this phase — (a) `git add -A` before/after a
  write-looking bash call, which is **dangerous in a shared worktree** (it stages
  another agent's work) and would have to be index-free (`GIT_INDEX_FILE` temp
  index, or `git stash create`); (b) an mtime/size/inode watermark diffed at turn
  end — cheap, backend-agnostic, but only ever answers *touched*, never *diffed*;
  (c) a pi extension hook on `tool_execution_start` — pi-web has no such hook
  point on the opencode side at all, so it guarantees asymmetric backends.

## 4. Live, cheaply

No watcher, no polling. Liveness comes from state that already exists:

- **Dirty-file badge**: comes from **git** (`/oc/fs/status`), not from the
  transcript — it is correct for out-of-band edits too, and it costs one command.
  A second, weaker marker (a `·` for "this session's tools touched this path",
  from `sessionChanges(tab)`) overlays it, so the two kinds of dirtiness stay
  distinguishable: "dirty, maybe by someone else" vs "this session said so".
- **Auto-expand to a touched file**: when a new edit lands while the Files tab is
  open, expand its ancestor chain (one `/fs/list` per level) and scroll to it.
- **`/oc/fs/status` refetch on `session.idle`** (already an SSE frame both
  backends emit, and pi-web's `agent_settled` fires it per turn) — that is the
  only "push" needed: the tree re-badges when a turn finishes, with no watcher and
  no timer.
- **Refresh on open only**: a directory listing is refetched when the drawer
  opens or on `↻`, never on a timer. A turn that writes 40 files must not cost 40
  listings.
- **The Changes tab needs no refresh at all** — it *is* the transcript.

## 5. Search (filenames only)

`/oc/fs/find` walks the ceiling-bounded tree with the ignore set applied,
substring match on the **name** (case-insensitive), directories included, capped
at 200 matches / depth 12. It never opens a file, never reads a byte of content.

Deliberately not `ripgrep`/`fd` spawns: both backends are pure-stdlib-or-stdlib-node
servers with no such dependency, and a spawn per keystroke in a container is a
cost, not a feature. JS walk with the ignore set is ~40 lines and fast enough at
the sizes these workspaces have. If it turns out slow, the fix is a cached index
with an mtime check, not a subprocess.

Client side: debounce 120 ms, Enter → reveal in tree + open the file, Esc → back
to the tree.

## 6. Checks (as shipped)

- `web/.testbin/fsbrowse-check.mjs` — the HTTP half, in the `npm test` chain on
  its own ports (8136/8137). 60 assertions; **71 failed on the pre-fix build**.
  Seeds a scratch tree in `os.tmpdir()` plus two fixture git repos, with the
  "outside the ceiling" fixture a SIBLING of the scratch dir — inside the repo
  under test, the ceiling assertions would be a tautology. Covers: listing shape
  and policy (ignore set, dotfiles-except-`.env`, dir-first A→Z, 500-cap +
  `truncated`); no global-root fallback (no cwd / dead cwd → 4xx naming it, and
  it lists NOTHING); containment (`..`, absolute path above the ceiling, cwd
  above the ceiling, `/etc/passwd`, `sub/../../..`); **symlink escape** (file 403,
  dir 403, find never walks out, in-ceiling links still read); the file shapes
  (text / NUL→binary / >1 MiB→`too_large` / image→base64 / missing→404); find
  (case-insensitive on NAMES only — a file whose *contents* hold the term must
  NOT match; dirs findable; ignore set; 200-cap; depth 11 found, depth 15 not);
  `status` (`{repo:false}` with no error; modified/added/deleted/untracked/renamed;
  `abs` keys; over-cap refusal); read-only-ness (the dirt and the empty stash
  list survive the call); `/fs/diff` (a deliberately STAGED edit still diffs via
  HEAD, untracked all-adds, deleted all-removes, non-repo 4xx, ceiling obeyed);
  and the **repo-above-ceiling** case through a SECOND bridge whose `--cwd` is a
  subdir of the repo — the file inside is badged, the files above are NOT named,
  and the answer admits `scoped`/`omitted`.
- `e2e/chatserver-fs-check.py` — the same contract on the python half, importing
  `chatserver` with `OC_FS_CEILING` pointed at a fixture tree (~62 assertions;
  red on the pre-fix build at the `FS_ROUTES` probe).
- `webui/src/lib/changes.test.ts` — the projection: three edits of one file stay
  THREE rows with their own patches (the merged pane cannot say that); a revert
  empties the list; `todowrite` is not an edit tool; a running or errored call is
  not a change; a write with no before-image is a row that ADMITS it; and a
  `sed -i`-only transcript yields zero diff rows plus exactly one hint, while a
  `grep`/`ls` turn yields neither.
- `web/.testbin/fsbox-check.mjs` — the **rendered** drawer (chromium + the
  sibling dist, SKIP-able through `optional.mjs`, port 8139). 24 assertions;
  **17 failed against the pre-fix bridge**. The tree as drawn, the git badges
  (● / +), a dirty file opening in a real Monaco **diff** editor carrying a
  change no tool part reported, the `file` toggle producing a single-model
  editor (this caught the §7 bug), untracked-as-all-adds, dir expansion, the
  Changes tab still drawing the old pane, and no container overflow.
- The renamed-header-cwd case is NOT re-tested here: the drawer browses
  `tab.cwd`, and `cwd-check.mjs` already pins that a session whose header cwd is
  gone answers a cwd that exists. Adding a second assertion of the same fallback
  through a different route would only duplicate it.

## 7. Two things the build taught

- **A Svelte reactive statement tracks only the identifiers it references
  itself.** `$: if (visible && path && cwd) load()` does NOT re-run when
  `load()`'s internal read of `mode` changes, so the `file | diff` toggle
  silently did nothing — every HTTP-layer and store-layer check stayed green and
  only the browser check saw it. `mode` now sits in the condition, and
  `fsbox-check`'s toggle assertion is what keeps it fixed.
- **`git diff` (worktree vs index) is the wrong comparison for a badge.** The
  drawer badges "dirty vs HEAD"; diffing against the index made staged files —
  e.g. anything another agent staged — render as "git reports no change" next to
  a ● badge. Both backend checks now stage a file ON PURPOSE to keep that honest.

## 8. Sequencing (done)

1. pi-web: `/oc/fs/{list,file,find,status,diff}` + `fsbrowse-check` (red first).
2. `chatserver.py`: the same routes as local dispatch + `chatserver-fs-check.py`.
3. webui: `lib/fs.ts`, `lib/monaco.ts`, `FileTree`, `FileViewer`, `FileBrowser`.
4. webui: `lib/changes.ts` (+ tests) and the drawer host in `App.svelte`;
   `Ctrl+D` semantics preserved, `/files` and `/changes` in the palette.
5. git badges + reveal-on-edit + `session.idle` → `bumpFsTick()` (the only push).
6. `fsbox-check` (rendered) and the full `cd web && npm test` gate.

## 9. Follow-up work (agreed, not in this phase)

**Improving the diff view** is explicitly deferred. Concretely, that means:

- message-level attribution for **out-of-band** edits (the three mechanisms in
  §3b, with the shared-worktree index hazard solved first);
- cumulative / per-file-across-turns diffs, and `write`-overwrite before-images;
- inline-vs-side-by-side parity in the transcript's own diff blocks;
- deciding whether `DiffPane`'s merged per-session mode is worth keeping once the
  Changes tab and the browser's git view both exist.

## 10. Out of scope (stated so it stays out)

write/edit/delete, `/api/open`, content search, filesystem watchers, any
mutating git command, and any change to `/oc/file/content`'s unguarded path
handling.
