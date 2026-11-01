#!/usr/bin/env python3
"""opencode chat server.

Single-origin backend for the webui:
  /, /webui/       -> webui/dist statics (SPA fallback to index.html)
  /oc/*            -> reverse proxy to the opencode engine (REST + SSE,
                      streamed). GET /oc/workspaces, /oc/fs/dirs and
                      /oc/fs/{list,file,find,status,diff} are served locally
                      instead (the engine has no such routes; see
                      workspace_root/chips/complete_directories and the
                      FS_ROUTES block — read-only, ceiling-bounded file browser
                      for the webui's Files drawer, docs/file-browser.md)
  /api/history/*   -> read-only sqlite access to opencode.db (sessions, transcript;
                      transcript accepts ?limit=N for a newest-N window)
  /api/history/session/{id}/errors
                   -> webui turn-failure tiles (GET list / POST {message,t} /
                      DELETE clear). Stored in the sidecar webui.db NEXT TO
                      opencode.db — the engine does not persist session.error
                      anywhere, so this is the only record. UNIQUE(sid,msg)
                      collapses duplicate inserts from multiple webui clients
                      witnessing the same SSE event.
  /api/history/session/{id}/meta
                   -> session metadata (star / tag). GET returns stored
                      state; PUT/POST merges a partial update
                      {star?: bool, tag?: string|null}; DELETE removes the
                      row. Stored in the smeta table in webui.db.
  /api/history/errors
                   -> ALL persisted errors across all sessions (background
                      collector records errors even when no webui tab is open).
  /api/search      -> full-text search (FTS5 trigram index in webui.db sidecar;
                       falls back to a substring scan only if the sidecar is missing)
  /healthz         -> liveness

A background SSE collector thread watches the engine's /event stream and
persists session.error and session.next.retried events to the sidecar, so
errors are visible to the webui even when no tab was open at the time.

Pure stdlib. Stateless: every /api request runs its own read-only SQL against
opencode.db (WAL-safe alongside a live engine/TUI) instead of materializing
the whole database in RAM. The sole write path is the tiny sidecar error
table (never touches opencode.db, which stays mode=ro + query_only). Statics
get ETag/304 revalidation, immutable caching for hashed /assets/, and
transparent .br/.gz precompressed serving.
Env: PORT(8080) HOST(0.0.0.0) OC_ENGINE(http://127.0.0.1:4096)
     OC_DB(/home/node/.local/share/opencode/opencode.db) WEBUI_DIST(./webui/dist)
     OC_WEBUI_DB(<dir of OC_DB>/webui.db)
"""

import base64
import gzip
import http.client
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, urlunparse

PORT = int(os.environ.get("PORT", "8080"))
HOST = os.environ.get("HOST", "0.0.0.0")
OC_DB = os.environ.get(
    "OC_DB", os.path.expanduser("~/.local/share/opencode/opencode.db")
)
WEBUI_DB = os.environ.get(
    "OC_WEBUI_DB", os.path.join(os.path.dirname(OC_DB) or ".", "webui.db")
)
OC_ENGINE = os.environ.get("OC_ENGINE", "http://127.0.0.1:4096").replace("http://", "")
WEBUI_DIST = os.path.abspath(
    os.environ.get("WEBUI_DIST", os.path.join(os.path.dirname(__file__), "webui", "dist"))
)

SNIPPET_CTX = 70
SEARCH_CAP = 300
FTS_SYNC_TTL = 30.0  # seconds between incremental syncs (opencode.db has no time_updated index)
WORKTREE = "/workspace/"

# FTS5 trigram index state (synced from opencode.db → webui.db)
_fts_lock = threading.Lock()
_fts_last_sync_ts = 0.0

# Placeholder Vite injects as the `nonce` attribute on inline <script>/<style>
# in the built index.html; static() swaps it for a fresh per-request nonce and
# sets the matching CSP script-src.
CSP_NONCE_PLACEHOLDER = "OPENCODE_CSP_NONCE"

# Context-size estimate summed from one assistant message's engine tokens.
TOKEN_SUM_SQL = (
    "COALESCE(json_extract(data,'$.tokens.input'),0)"
    "+COALESCE(json_extract(data,'$.tokens.output'),0)"
    "+COALESCE(json_extract(data,'$.tokens.reasoning'),0)"
    "+COALESCE(json_extract(data,'$.tokens.cache.read'),0)"
    "+COALESCE(json_extract(data,'$.tokens.cache.write'),0)"
)

# Generated tokens = what the model produced: output + reasoning, summed over
# EVERY assistant message of the session. Deliberately excludes input and
# cache.read/write: measured on the real engine DB, those are 95.6-99.5% of a
# session's raw token volume (top session: 177.7M cache.read vs 3.7M input and
# 0.18M output), so a raw sum scales with turn count, not with work done.
# Summed from `message` rather than read off session.tokens_output/
# tokens_reasoning: those columns ARE the exact same cumulative sum (verified
# digit-for-digit over the top sessions), but the message-level sum is the
# definition and doesn't depend on the engine keeping the rollup in sync.
GEN_SUM_SQL = (
    "COALESCE(json_extract(data,'$.tokens.output'),0)"
    "+COALESCE(json_extract(data,'$.tokens.reasoning'),0)"
)


def num(v):
    """Best-effort epoch-ms coercion for time-ish columns."""
    if v is None:
        return 0
    if isinstance(v, (int, float)):
        return int(v)
    try:
        return int(float(v))
    except ValueError:
        pass
    try:
        j = json.loads(v)
        return num(j.get("created") if isinstance(j, dict) else j)
    except Exception:
        return 0


# ---- workspaces (pi-web parity) -------------------------------------------
# Sidebar groups come from session.directory (load_sessions -> `cwd`); the
# picker's chips + type-ahead come from workspace_chips()/complete_directories()
# off the engine's own /path root. The client folds the engine's `directory`
# field into `cwd` on read as well (webui lib/api.ts withCwd) so both read
# paths hand the UI one field.
#
# The engine CANNOT pin a new session's directory — three routes verified dead
# against a live engine (opencode 1.18.x), do not re-litigate:
#   - POST /session is additionalProperties:false: no cwd/path/directory field
#   - `projectID` in that body is silently ignored (session lands in the
#     server's own project/directory)
#   - POST /experimental/control-plane/move-session rejects a destination
#     outside the session's project ("Destination directory belongs to another
#     project")
# So proxy() drops the picker's `cwd` from the create body — a raw one 400s —
# and the created session's own `directory` comes back to correct the tab chip.

_ws_root = None


def workspace_root():
    """Engine working directory (cached) — chips and completion base."""
    global _ws_root
    if _ws_root is None:
        root = ""
        try:
            conn = http.client.HTTPConnection(OC_ENGINE, timeout=5)
            conn.request("GET", "/path")
            r = conn.getresponse()
            root = json.loads(r.read() or b"{}").get("directory") or ""
            conn.close()
        except Exception:
            pass
        _ws_root = root or os.getcwd()
    return _ws_root


def workspace_chips():
    """Every workspace a session has run in (most recent first), then the
    child dirs of the engine root that have never been used — pi-web's chips."""
    seen = {}  # path -> last activity ms (0 = never used)
    with _connect() as c:
        for p, t in c.execute(
            "SELECT directory, MAX(time_updated) FROM session"
            " WHERE directory IS NOT NULL AND directory != '' GROUP BY directory"
        ):
            seen[p] = num(t)
    try:
        root = workspace_root()
        for name in os.listdir(root):
            full = os.path.join(root, name)
            if not name.startswith(".") and os.path.isdir(full):
                seen.setdefault(full, 0)
    except OSError:
        pass  # root unreadable — the session workspaces above still list
    return [
        {"name": os.path.basename(p) or p, "path": p}
        for p in sorted(seen, key=lambda p: (-seen[p], p))[:24]
    ]


def complete_directories(prefix):
    """Directory suggestions for the picker's type-ahead (drill-in semantics):
    everything up to the last '/' names the dir to list, the rest matches
    child names; '~' expands, relative prefixes resolve against the root."""
    text = str(prefix or "")
    if text == "~":
        text = "~/"
    if text.startswith("~/"):
        text = os.path.expanduser("~") + text[1:]
    slash = text.rfind("/")
    dir_part = text[: slash + 1] if slash != -1 else ""
    partial = text[slash + 1 :].lower()
    d = os.path.abspath(os.path.join(workspace_root(), dir_part or "."))
    try:
        names = sorted(os.listdir(d))
    except OSError:
        return []
    out = []
    for n in names:
        if not n.lower().startswith(partial):
            continue
        if not partial.startswith(".") and n.startswith("."):
            continue
        full = os.path.join(d, n)
        if not os.path.isdir(full):
            continue
        out.append({"name": n, "path": full})
        if len(out) >= 50:  # cap the list at 50 suggestions per level
            break
    return out


def _connect():
    uri = "file:%s?mode=ro" % OC_DB
    conn = sqlite3.connect(uri, uri=True, timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only=1")
    # Unicode-aware lowercase inside SQL (sqlite's lower() is ASCII-only);
    # keeps search semantics identical to the previous in-Python index.
    conn.create_function("pylower", 1, lambda s: s.lower() if s else s)
    return conn


# ---- sidecar: webui turn-failure tiles -------------------------------------
# The engine fires session.error over SSE but persists nothing, so the webui
# records failures here to survive reloads. Tiny append-only table; UNIQUE
# (sid,msg) makes concurrent POSTs from several clients idempotent.

def _serr_connect(create=False):
    if create:
        os.makedirs(os.path.dirname(WEBUI_DB) or ".", exist_ok=True)
        conn = sqlite3.connect(WEBUI_DB, timeout=5)
        conn.execute(
            "CREATE TABLE IF NOT EXISTS serr("
            "seq INTEGER PRIMARY KEY AUTOINCREMENT,"
            "sid TEXT NOT NULL,"
            "msg TEXT NOT NULL,"
            "t INTEGER NOT NULL,"
            "UNIQUE(sid,msg))"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS smeta("
            "sid TEXT PRIMARY KEY,"
            "star INTEGER NOT NULL DEFAULT 0,"
            "tag TEXT)"
        )
        conn.commit()
        return conn
    conn = sqlite3.connect("file:%s?mode=ro" % WEBUI_DB, uri=True, timeout=5)
    return conn


def session_errors(sid):
    try:
        conn = _serr_connect()
    except Exception:
        return []
    try:
        rows = conn.execute(
            "SELECT seq, msg, t FROM serr WHERE sid=? ORDER BY seq", (sid,)
        ).fetchall()
        return [{"seq": r[0], "message": r[1], "t": r[2]} for r in rows]
    except sqlite3.OperationalError:
        return []  # table not created yet
    finally:
        conn.close()


def session_error_add(sid, message, t=None):
    conn = _serr_connect(create=True)
    try:
        cur = conn.execute(
            "INSERT OR IGNORE INTO serr(sid,msg,t) VALUES(?,?,?)",
            (sid, message, int(t or time.time() * 1000)),
        )
        conn.commit()
        return {"ok": True, "seq": cur.lastrowid if cur.rowcount else None}
    finally:
        conn.close()


def session_error_clear(sid):
    conn = _serr_connect(create=True)
    try:
        conn.execute("DELETE FROM serr WHERE sid=?", (sid,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


def session_errors_all():
    """Return ALL persisted errors across all sessions (for the global endpoint)."""
    try:
        conn = _serr_connect()
    except Exception:
        return []
    try:
        rows = conn.execute(
            "SELECT sid, msg, t FROM serr ORDER BY t DESC LIMIT 500"
        ).fetchall()
        return [{"sid": r[0], "message": r[1], "t": r[2]} for r in rows]
    except sqlite3.OperationalError:
        return []
    finally:
        conn.close()


# ---- sidecar: session metadata (star / tag) --------------------------------

def session_meta_read_all():
    """Return {sid: {"star": bool, "tag": str|None}} for all meta rows."""
    try:
        conn = _serr_connect()
    except Exception:
        return {}
    try:
        rows = conn.execute("SELECT sid, star, tag FROM smeta").fetchall()
        return {r[0]: {"star": bool(r[1]), "tag": r[2]} for r in rows}
    except sqlite3.OperationalError:
        return {}
    finally:
        conn.close()


def session_meta_write(sid, star, tag):
    """Full replace of the smeta row. DELETEs when both falsy."""
    conn = _serr_connect(create=True)
    try:
        if not star and not tag:
            conn.execute("DELETE FROM smeta WHERE sid=?", (sid,))
        else:
            conn.execute(
                "INSERT INTO smeta(sid,star,tag) VALUES(?,?,?)"
                " ON CONFLICT(sid) DO UPDATE SET star=excluded.star, tag=excluded.tag",
                (sid, int(bool(star)), tag or None),
            )
        conn.commit()
        return {"star": bool(star), "tag": tag or None}
    finally:
        conn.close()


def session_meta_delete(sid):
    """Delete the meta row for a session."""
    conn = _serr_connect(create=True)
    try:
        conn.execute("DELETE FROM smeta WHERE sid=?", (sid,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


def _session_meta_get(sid):
    """Single-row read for one session's meta."""
    try:
        conn = _serr_connect()
    except Exception:
        return None
    try:
        r = conn.execute(
            "SELECT star, tag FROM smeta WHERE sid=?", (sid,)
        ).fetchone()
        if r is None:
            return None
        return {"star": bool(r[0]), "tag": r[1]}
    except sqlite3.OperationalError:
        return None
    finally:
        conn.close()


# ---- background SSE collector -----------------------------------------------
# Listens to the engine's SSE stream and persists session.error and
# session.next.retried events to the sidecar. This ensures errors are
# recorded even when no webui tab is open.
_collector_lock = threading.Lock()


def _sse_collector():
    """Background daemon thread: tail engine /event, persist error events."""
    import http.client as _http

    while True:
        conn = None
        try:
            host, port = OC_ENGINE.split(":")[0], int(OC_ENGINE.split(":")[1])
            conn = _http.HTTPConnection(host, port, timeout=300)
            conn.request("GET", "/event", headers={"Accept": "text/event-stream"})
            resp = conn.getresponse()
            if resp.status != 200:
                time.sleep(5)
                continue
            event_type = ""
            data_buf = []
            for raw_line in resp:
                line = raw_line.decode("utf-8", errors="replace")
                if line.startswith("event:"):
                    event_type = line[6:].strip()
                elif line.startswith("data:"):
                    data_buf.append(line[5:].strip())
                elif line.strip() == "" and data_buf:
                    # end of SSE frame — process it
                    _process_sse_event(event_type, "".join(data_buf))
                    event_type = ""
                    data_buf = []
        except Exception:
            time.sleep(5)
        finally:
            if conn:
                try:
                    conn.close()
                except Exception:
                    pass


def _process_sse_event(event_type, data_str):
    """Parse and persist error/retry events from the engine SSE stream."""
    if event_type not in ("session.error", "session.next.retried"):
        return
    try:
        data = json.loads(data_str)
    except (json.JSONDecodeError, TypeError):
        return
    props = data.get("properties", data)
    sid = props.get("sessionID") or props.get("info", {}).get("sessionID") or props.get("info", {}).get("id")
    if not sid:
        return
    em = props.get("error")
    if not em:
        return
    msg = str(em.get("data", {}).get("message") or em.get("message") or em.get("name") or "error")
    if event_type == "session.next.retried":
        attempt = props.get("attempt", 1)
        msg = f"[retry attempt #{attempt}] {msg}"
    with _collector_lock:
        try:
            conn = _serr_connect(create=True)
            try:
                conn.execute(
                    "INSERT OR IGNORE INTO serr(sid, msg, t) VALUES(?,?,?)",
                    (sid, msg, int(time.time() * 1000)),
                )
                conn.commit()
            finally:
                conn.close()
        except Exception:
            pass


def load_sessions():
    out = []
    with _connect() as c:
        # Context estimate per session: newest assistant message with a
        # NON-ZERO tally (aborted/empty/provider-silent turns leave all-zero
        # tokens objects behind — those must read as "no data", not 0).
        # Walks message_session_time_created_id_idx DESC and stops at the
        # first hit; ~1-2 ms for ~150 sessions / ~11k messages.
        tok = {
            r["sid"]: r["tk"]
            for r in c.execute(
                f"""SELECT s.id sid,
                       (SELECT {TOKEN_SUM_SQL} FROM message m
                        WHERE m.session_id=s.id
                          AND json_extract(m.data,'$.role')='assistant'
                          AND {TOKEN_SUM_SQL} > 0
                        ORDER BY m.time_created DESC LIMIT 1) tk
                    FROM session s"""
            )
            if r["tk"] is not None
        }
        rows = c.execute(
            """SELECT s.id, s.title, s.cost, s.model, s.parent_id, s.agent,
                      s.directory, s.time_created tc,
                      s.time_updated tu, COUNT(m.id) n
               FROM session s LEFT JOIN message m ON m.session_id = s.id
               GROUP BY s.id ORDER BY s.rowid DESC"""
        )
        # Generated tokens per session: one pass over `message` (GROUP BY uses the
        # message_session index; ~11k messages = a few ms).
        gen = {
            r["sid"]: int(r["g"])
            for r in c.execute(
                f"""SELECT m.session_id sid, SUM({GEN_SUM_SQL}) g
                    FROM message m
                    WHERE json_extract(m.data,'$.role')='assistant'
                    GROUP BY m.session_id"""
            )
            if (r["g"] or 0) > 0
        }
        for r in rows:
            model = r["model"] or ""
            model_provider = ""
            if isinstance(model, str) and model.startswith("{"):
                try:
                    mj = json.loads(model)
                    model = mj.get("id") or ""
                    model_provider = mj.get("providerID") or ""
                except Exception:
                    model = ""
            created = num(r["tc"])
            entry = {
                "id": r["id"],
                "title": r["title"] or "",
                "cost": float(r["cost"] or 0),
                "model": model,
                # provider kept separate so the sidebar tooltip can show
                # provider/id while the row text stays the bare model id
                "model_provider": model_provider,
                "parent": r["parent_id"] or "",
                "agent": r["agent"] or "",
                # workspace the session runs in (sidebar group headers / tab
                # chip); empty string = unknown, webui renders flat
                "cwd": r["directory"] or "",
                "created": created,
                "updated": num(r["tu"]) or created,
                "message_count": r["n"],
            }
            if r["id"] in tok:
                entry["tokens"] = tok[r["id"]]
            if r["id"] in gen:
                # SELF-ONLY: subagent sessions are separate rows; the webui sums
                # the descendant subtree (webui/src/lib/gentokens.ts).
                entry["tokens_generated"] = gen[r["id"]]
            out.append(entry)
    # Merge session meta (star / tag) from the sidecar webui.db.
    # session_meta_read_all() swallows all errors — safe to call unconditionally.
    meta = session_meta_read_all()
    for entry in out:
        m = meta.get(entry["id"])
        if m:
            if m["star"]:
                entry["star"] = True
            tag = m.get("tag")
            if tag:
                entry["tag"] = tag
    return out


def load_messages(sid, limit=None):
    """Transcript projection for one session.

    limit: newest-N window (ascending). Parts are fetched only for the
    selected messages — the difference between a 400-message and a full
    multi-thousand-part transcript payload is ~10x JSON build + transfer.
    """
    msgs = []
    with _connect() as c:
        if not c.execute("SELECT 1 FROM session WHERE id=?", (sid,)).fetchone():
            return None
        if limit:
            rows = c.execute(
                """SELECT id, data FROM
                     (SELECT id, data, time_created FROM message WHERE session_id=?
                      ORDER BY time_created DESC LIMIT ?)
                   ORDER BY time_created""",
                (sid, limit),
            ).fetchall()
        else:
            rows = c.execute(
                "SELECT id, data FROM message WHERE session_id=? ORDER BY time_created",
                (sid,),
            ).fetchall()
        for mr in rows:
            md = json.loads(mr["data"] or "{}")
            msgs.append(
                {
                    "id": mr["id"],
                    "role": md.get("role", "assistant"),
                    "agent": (md.get("agent") or "") or None,
                    "modelID": ((md.get("model") or {}).get("modelID")) or None,
                    "time": num((md.get("time") or {}).get("created")),
                    # mid-turn failures: engine stamps the error on the assistant
                    # message (TUI renders it inline too); absent on instant fails
                    "error": md.get("error"),
                    "tokens": md.get("tokens"),
                    "parts": [],
                }
            )
        pos = {m["id"]: m for m in msgs}
        if limit:
            ph = ",".join("?" * len(pos))
            prs = c.execute(
                f"""SELECT id, message_id, data FROM part
                    WHERE session_id=? AND message_id IN ({ph})
                    ORDER BY time_created""",
                [sid, *pos.keys()],
            )
        else:
            prs = c.execute(
                "SELECT id, message_id, data FROM part WHERE session_id=? ORDER BY time_created",
                (sid,),
            )
        for pr in prs:
            m = pos.get(pr["message_id"])
            if not m:
                continue
            pd = json.loads(pr["data"] or "{}")
            ptype = pd.get("type", "")
            tool = pd.get("tool") or pd.get("toolName") or (
                ptype if ptype not in ("text",) else ""
            )
            state = pd.get("state") or {}
            summary = state.get("status") or state.get("title") or ""
            m["parts"].append(
                {
                    "id": pr["id"],
                    "type": ptype,
                    "text": pd.get("text"),
                    "tool": tool or None,
                    "state": state or None,
                    "state_summary": summary[:120],
                    # engine-injected subagent task results (synthetic user msgs)
                    "synthetic": True if pd.get("synthetic") else None,
                }
            )
    return msgs


def _build_snippet(original, terms):
    """Build highlighted snippet from original text for one or more search terms.

    Finds the earliest case-insensitive match of ANY term in the text, takes a
    window of ±SNIPPET_CTX chars around it, then wraps every occurrence of EVERY
    term in \\x00/\\x01 sentinels using a per-char boolean mask so overlapping
    matches never produce nested/duplicated sentinels.  Preserves original casing,
    replaces newlines with spaces, adds leading/trailing ellipsis as needed.
    """
    low = original.lower()
    # find earliest match position of any term
    earliest_pos = -1
    earliest_len = 0
    for t in terms:
        idx = low.find(t)
        if idx >= 0 and (earliest_pos < 0 or idx < earliest_pos):
            earliest_pos = idx
            earliest_len = len(t)
    if earliest_pos < 0:
        return ""
    a = max(0, earliest_pos - SNIPPET_CTX)
    b = min(len(low), earliest_pos + earliest_len + SNIPPET_CTX)
    window = original[a:b]
    wl = window.lower()
    # boolean mask: True where any term matches
    mask = [False] * len(window)
    for t in terms:
        tl = len(t)
        pos = 0
        while True:
            j = wl.find(t, pos)
            if j < 0:
                break
            for k in range(j, j + tl):
                mask[k] = True
            pos = j + tl
    # emit contiguous runs wrapped in sentinels
    marked = []
    i = 0
    while i < len(mask):
        if mask[i]:
            j = i
            while j < len(mask) and mask[j]:
                j += 1
            marked.append("\x00")
            marked.append(window[i:j])
            marked.append("\x01")
            i = j
        else:
            j = i
            while j < len(mask) and not mask[j]:
                j += 1
            marked.append(window[i:j])
            i = j
    return ("…" if a > 0 else "") + "".join(marked).replace("\n", " ") + (
        "…" if b < len(low) else ""
    )


def _fts_sync():
    """Sync opencode.db text parts into a trigram FTS5 index in webui.db.

    First call (or after error) does a full rebuild; subsequent calls do
    incremental updates throttled to one every FTS_SYNC_TTL seconds.
    Returns True on success, False on error (caller falls back to legacy scan).
    """
    global _fts_last_sync_ts
    now = time.time()
    if now - _fts_last_sync_ts < FTS_SYNC_TTL:
        return True
    with _fts_lock:
        # double-check after acquiring lock
        if time.time() - _fts_last_sync_ts < FTS_SYNC_TTL:
            return True
        try:
            oc = _connect()
            wc = _serr_connect(create=True)
            try:
                wc.execute(
                    "CREATE TABLE IF NOT EXISTS fts_meta("
                    "k TEXT PRIMARY KEY, v TEXT)"
                )
                built_row = wc.execute(
                    "SELECT v FROM fts_meta WHERE k='fts_built'"
                ).fetchone()
                full_rebuild = built_row is None
                wc.execute(
                    "CREATE VIRTUAL TABLE IF NOT EXISTS part_fts "
                    "USING fts5(txt, pid UNINDEXED, mid UNINDEXED, "
                    "sid UNINDEXED, role UNINDEXED, tc UNINDEXED, "
                    "tokenize='trigram')"
                )
                if full_rebuild:
                    wc.execute("DELETE FROM part_fts")
                # build scan query
                wm = 0
                if full_rebuild:
                    scan_sql = (
                        "SELECT p.rowid rid, p.id, p.message_id,"
                        " p.session_id,"
                        " json_extract(p.data,'$.text') txt,"
                        " COALESCE(json_extract(m.data,'$.role'),"
                        " 'assistant') role,"
                        " p.time_created tc, p.time_updated tu"
                        " FROM part p"
                        " JOIN message m ON m.id=p.message_id"
                        "  AND m.session_id=p.session_id"
                        " WHERE json_extract(p.data,'$.type')='text'"
                        "  AND json_extract(p.data,'$.text') IS NOT NULL"
                    )
                    params = ()
                else:
                    wm_row = wc.execute(
                        "SELECT v FROM fts_meta WHERE k='fts_wm'"
                    ).fetchone()
                    wm = int(wm_row[0]) if wm_row else 0
                    scan_sql = (
                        "SELECT p.rowid rid, p.id, p.message_id,"
                        " p.session_id,"
                        " json_extract(p.data,'$.text') txt,"
                        " COALESCE(json_extract(m.data,'$.role'),"
                        " 'assistant') role,"
                        " p.time_created tc, p.time_updated tu"
                        " FROM part p"
                        " JOIN message m ON m.id=p.message_id"
                        "  AND m.session_id=p.session_id"
                        " WHERE json_extract(p.data,'$.type')='text'"
                        "  AND json_extract(p.data,'$.text') IS NOT NULL"
                        "  AND p.time_updated > ?"
                    )
                    params = (wm,)
                rows = oc.execute(scan_sql, params).fetchall()
                max_tu = 0
                for r in rows:
                    tu = num(r["tu"])
                    if tu > max_tu:
                        max_tu = tu
                    wc.execute(
                        "INSERT OR REPLACE INTO part_fts"
                        "(rowid,txt,pid,mid,sid,role,tc)"
                        " VALUES(?,?,?,?,?,?,?)",
                        (r["rid"], r["txt"], r["id"],
                         r["message_id"], r["session_id"],
                         r["role"], r["tc"]),
                    )
                # only advance the watermark — an empty incremental must not
                # reset it to 0 (that forces a full rescan on the next sync)
                if max_tu > wm:
                    wc.execute(
                        "INSERT OR REPLACE INTO fts_meta(k,v)"
                        " VALUES('fts_wm',?)",
                        (str(max_tu),),
                    )
                wc.execute(
                    "INSERT OR REPLACE INTO fts_meta(k,v)"
                    " VALUES('fts_built','1')"
                )
                wc.commit()
                _fts_last_sync_ts = time.time()
                return True
            finally:
                wc.close()
                oc.close()
        except Exception:
            # fts_built stays unset → next call retries full rebuild;
            # caller falls through to legacy scan for this request.
            return False


# ---- search ----------------------------------------------------------------

def search(q):
    ql = q.lower().strip()
    terms = ql.split()
    if len(ql) < 2 or not terms:
        return []
    hits = []
    # Refresh the sidecar index in the BACKGROUND if stale — never block a
    # search request on sync (a cold full rebuild holds the lock for seconds).
    # Boot warms via fts-warm; this only covers the every-FTS_SYNC_TTL refresh.
    if time.time() - _fts_last_sync_ts >= FTS_SYNC_TTL and not _fts_lock.locked():
        threading.Thread(target=_fts_sync, daemon=True, name="fts-sync").start()
    with _connect() as c:
        titles = {
            r["id"]: r["title"] or r["id"][:12]
            for r in c.execute("SELECT id, title FROM session")
        }
        # part_fts lives in webui.db (writable sidecar), NOT opencode.db.
        # Table is created by _fts_sync (boot warm / background refresh).
        try:
            wc = sqlite3.connect("file:%s?mode=ro" % WEBUI_DB, uri=True, timeout=5)
            wc.row_factory = sqlite3.Row
            # unicode-aware lowercase for the short-term (sub-trigram) path
            wc.create_function("pylower", 1, lambda s: s.lower() if s else s)
            try:
                if all(len(t) >= 3 for t in terms):
                    # trigram MATCH — all terms >= 3 chars
                    match_expr = " AND ".join(
                        '"' + t.replace('"', '""') + '"' for t in terms
                    )
                    cur = wc.execute(
                        "SELECT pid,mid,sid,role,tc,txt"
                        " FROM part_fts WHERE part_fts MATCH ?"
                        " ORDER BY tc DESC",
                        (match_expr,),
                    )
                else:
                    # sub-trigram: substring scan of the sidecar index only
                    # (no json_extract/part⋈message — ~40x faster than legacy)
                    conds = " AND ".join(
                        "instr(pylower(txt),?)>0" for _ in terms
                    )
                    cur = wc.execute(
                        "SELECT pid,mid,sid,role,tc,txt FROM part_fts"
                        " WHERE " + conds + " ORDER BY tc DESC",
                        tuple(terms),
                    )
                for r in cur:
                    if r["sid"] not in titles:
                        continue
                    hits.append(
                        {
                            "session_id": r["sid"],
                            "session_title": titles.get(r["sid"], r["sid"][:12]),
                            "message_id": r["mid"],
                            "part_id": r["pid"],
                            "role": r["role"],
                            "time": num(r["tc"]),
                            "snippet": _build_snippet(r["txt"], terms),
                        }
                    )
                    if len(hits) >= SEARCH_CAP:
                        break
                return hits
            finally:
                wc.close()
        except Exception:
            pass  # sidecar missing/broken → legacy scan below
        # Legacy brute-force with AND semantics (one instr per term)
        conds = " AND ".join(
            "instr(pylower(CAST(json_extract(p.data,'$.text') AS TEXT)),?)>0"
            for _ in terms
        )
        cur = c.execute(
            """SELECT p.id pid, p.message_id mid, p.session_id sid,
                      json_extract(p.data, '$.text') txt,
                      COALESCE(json_extract(m.data, '$.role'), 'assistant') role,
                      p.time_created tcreated
               FROM part p
               JOIN message m ON m.id = p.message_id AND m.session_id = p.session_id
               WHERE json_extract(p.data, '$.type') = 'text'
                 AND json_extract(p.data, '$.text') IS NOT NULL
                 AND """ + conds + """
               ORDER BY p.time_created DESC""",
            tuple(terms),
        )
        for r in cur:
            if r["sid"] not in titles:
                continue
            hits.append(
                {
                    "session_id": r["sid"],
                    "session_title": titles.get(r["sid"], r["sid"][:12]),
                    "message_id": r["mid"],
                    "part_id": r["pid"],
                    "role": r["role"],
                    "time": num(r["tcreated"]),
                    "snippet": _build_snippet(r["txt"], terms),
                }
            )
            if len(hits) >= SEARCH_CAP:
                break
    return hits


def _rel(path):
    """Worktree-relative path for display/content-fetch parity with vcs/diff."""
    p = path or ""
    return p[len(WORKTREE):] if p.startswith(WORKTREE) else p.lstrip("/")


V4A_SECTION_RE = re.compile(r"^\*\*\* (Add|Update|Delete) File: (.+?)\s*$")


def _v4a_sections(patch_text):
    """Split a V4A patchText into [(action, path, body_lines)] per file."""
    out, action, path, body = [], None, None, []
    for line in (patch_text or "").split("\n"):
        m = V4A_SECTION_RE.match(line)
        if m:
            if action:
                out.append((action, path, body))
            action, path, body = m.group(1), m.group(2), []
        elif action and not line.startswith("***"):
            body.append(line)
    if action:
        out.append((action, path, body))
    return out


def _v4a_to_unified(body, force_add=False):
    """Convert one V4A section body into unified-diff hunk text.

    V4A hunks are context-anchored ('@@' separators optional, no line
    numbers); we emit '@@ -1,O +1,N @@' headers and let the client locate
    hunks by content match (matchAt scans from top as fallback).
    force_add: Add File sections must yield pure additions — some models
    emit blank or stray unprefixed lines there.
    """
    if force_add:
        body = [("+" + (l[1:] if l.startswith("+") else l)) for l in body]
    chunks, cur = [], []
    for line in body:
        if line.startswith("@@"):
            if cur:
                chunks.append(cur)
            cur = []
        else:
            cur.append(line)
    if cur:
        chunks.append(cur)
    parts = []
    for ch in chunks:
        old = sum(1 for l in ch if l.startswith(("-", " ")))
        new = sum(1 for l in ch if l.startswith(("+", " ")))
        parts.append("@@ -1,%d +1,%d @@" % (old, new))
        parts.extend(ch)
    return "\n".join(parts)


def session_changes(sid):
    """Per-file chronological ops (edit/write/apply_patch) for one session.

    Minimal projection only: edit -> filediff.patch; write -> '+' pseudo-patch
    for creates (overwrites have no before-image anywhere in the transcript);
    apply_patch -> split V4A patchText per file, converted to unified hunks.
    """
    files, order = {}, []

    def add(path, op):
        p = _rel(path)
        if p not in files:
            files[p] = []
            order.append(p)
        files[p].append(op)

    with _connect() as c:
        if not c.execute("SELECT 1 FROM session WHERE id=?", (sid,)).fetchone():
            return None
        rows = c.execute(
            """SELECT data FROM part
               WHERE session_id=?
                 AND json_extract(data,'$.type')='tool'
                 AND json_extract(data,'$.tool') IN ('edit','write','apply_patch')
               ORDER BY time_created""",
            (sid,),
        )
        for (data,) in rows:
            pd = json.loads(data or "{}")
            st = pd.get("state") or {}
            if st.get("status") != "completed":
                continue
            t = st.get("time") or {}
            ts = num(t.get("end")) or num(t.get("start"))
            tool = pd["tool"]
            inp = st.get("input") or {}
            md = st.get("metadata") or {}

            if tool == "edit":
                fd = md.get("filediff") or {}
                path = fd.get("file") or inp.get("filePath")
                patch = fd.get("patch") or md.get("diff")
                if path and patch:
                    add(path, {"k": "edit", "t": ts, "patch": patch})

            elif tool == "write":
                path = inp.get("filePath")
                if not path:
                    continue
                if md.get("exists"):
                    # overwrite: pre-image unrecoverable from the transcript
                    add(path, {"k": "write", "t": ts, "exists": True})
                else:
                    lines = (inp.get("content") or "").split("\n")
                    if lines and lines[-1] == "":
                        lines.pop()
                    add(
                        path,
                        {
                            "k": "write",
                            "t": ts,
                            "patch": "@@ -0,0 +1,%d @@" % len(lines)
                            + ("\n" + "\n".join("+" + l for l in lines) if lines else ""),
                        },
                    )

            else:  # apply_patch
                for action, vpath, body in _v4a_sections(inp.get("patchText")):
                    if action == "Delete":
                        add(vpath, {"k": "delete", "t": ts})
                    else:
                        add(
                            vpath,
                            {
                                "k": "patch",
                                "t": ts,
                                "patch": _v4a_to_unified(body, force_add=action == "Add"),
                            },
                        )

    return {"files": [{"file": p, "ops": files[p]} for p in order]}


# ---------------------------------------------------------------------------
# File browser — GET /oc/fs/{list,file,find,status,diff}
#
# Same contract, same rules and same JSON shapes as pi-web's /oc/fs/*, because
# the webui's Files drawer is one component talking to two backends (docs/
# file-browser.md). Read-only end to end: no write route, no OS opener, and
# read-only GIT ONLY — this worktree routinely carries another agent's
# in-flight edits, so `git add`/`stash`/`checkout` from a browser drawer is a
# data-loss bug, not a style problem. (`GIT_OPTIONAL_LOCKS=0` matters: plain
# `git status` REFRESHES and rewrites .git/index, which is a write.)
#
# The CEILING is what stands between these routes and an arbitrary-read
# endpoint: every request names a `cwd` (the drawer follows the tab), nothing
# may resolve above it, and a symlink is only usable if where it POINTS is also
# allowed. Deliberately NOT /oc/file/content, which takes an absolute path with
# no containment because it exists to read a before-image the transcript already
# named.
# ---------------------------------------------------------------------------

FS_LIST_CAP = 500
FS_FIND_CAP = 200
FS_MAX_DEPTH = 12
FS_FILE_BYTES = 1024 * 1024
FS_DIFF_BYTES = 512 * 1024
# Overridable so a check can prove the refusal without seeding 20k files.
FS_STATUS_CAP = int(os.environ.get("OC_FS_STATUS_CAP") or 20000)
FS_CEILING = os.path.realpath(os.environ.get("OC_FS_CEILING") or WORKTREE)
# tau's IGNORED_NAMES (pi-tau-web-server/bin/server-main.js) plus the few that
# only bite once a repo is under the root. `.env` is the ONE dotfile that stays
# visible — reading it is a common reason to open the drawer.
FS_IGNORE = {
    "node_modules", ".git", "__pycache__", ".DS_Store", ".Trash", ".next", ".nuxt",
    "dist", "build", ".cache", ".turbo", "venv", ".venv", "env", ".env.local", ".pi",
    "coverage", ".nyc_output", ".parcel-cache", ".pytest_cache", "target",
}
FS_IMAGE = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".avif": "image/avif",
}


class FsError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def fs_hidden(name):
    return name in FS_IGNORE or (name.startswith(".") and name != ".env")


def fs_within(x, root):
    return x == root or x.startswith(root + os.sep)


def fs_root(qs):
    """Validate the cwd param: required, a real directory, inside the ceiling."""
    raw = (qs.get("cwd") or [""])[0].strip()
    if not raw:
        raise FsError(400, "cwd is required — the drawer browses the session workspace, never a server-wide root")
    raw = os.path.expanduser(raw)
    abs_ = os.path.abspath(raw)
    if not fs_within(abs_, FS_CEILING):
        raise FsError(403, "%s is outside the workspace ceiling (%s)" % (abs_, FS_CEILING))
    real = os.path.realpath(abs_)
    if not fs_within(real, FS_CEILING):
        raise FsError(403, "%s resolves to %s, outside the workspace ceiling (%s)" % (abs_, real, FS_CEILING))
    if not os.path.isdir(real):
        raise FsError(400, "not a directory: %s" % raw)
    return real


def fs_path(root, p):
    """Resolve one path under a root; (abs, real-or-None), ceiling-checked both."""
    raw = (p or "").strip()
    abs_ = os.path.abspath(os.path.join(root, os.path.expanduser(raw))) if raw else root
    if not fs_within(abs_, FS_CEILING):
        raise FsError(403, "%s is outside the workspace ceiling (%s)" % (abs_, FS_CEILING))
    real = os.path.realpath(abs_) if os.path.exists(abs_) else None
    # tau's rule: a symlink is only usable if where it POINTS is allowed too.
    if real and not fs_within(real, FS_CEILING):
        raise FsError(403, "%s is a symlink to %s, outside the workspace ceiling (%s)" % (abs_, real, FS_CEILING))
    return abs_, real


def git_out(cwd, args):
    """Read-only git. None on failure ("not a repo", "no such path in HEAD", …)."""
    try:
        r = subprocess.run(
            ["git", "-C", cwd] + args,
            capture_output=True,
            timeout=15,
            env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"},
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode != 0:
        return None
    return r.stdout.decode("utf-8", "replace")


def fs_list(qs):
    root = fs_root(qs)
    abs_, real = fs_path(root, (qs.get("path") or [""])[0])
    d = real or abs_
    try:
        scan = list(os.scandir(d))
    except OSError as e:
        raise FsError(404 if e.errno == 2 else 400, "cannot list %s: %s" % (abs_, e.strerror))
    if not os.path.isdir(d):
        raise FsError(400, "not a directory: %s" % abs_)
    items = []
    for e in scan:
        if fs_hidden(e.name):
            continue
        try:
            st = e.stat(follow_symlinks=False)  # never stat THROUGH a symlink
            mtime = st.st_mtime * 1000.0
            is_dir = e.is_dir(follow_symlinks=False)
            size = None if is_dir else st.st_size
            link = e.is_symlink()
            escapes = False
            if link:
                size = None  # parity with pi-web: a link's own byte count is noise
                t = os.path.realpath(e.path)
                if fs_within(t, FS_CEILING):
                    is_dir = os.path.isdir(t)
                    size = None
                else:
                    escapes = True  # listed so the drawer can grey it out; reads 403
        except OSError:
            continue  # raced away
        item = {"name": e.name, "path": e.path, "isDirectory": is_dir, "size": size, "mtime": mtime}
        if link:
            item["symlink"] = True
        if escapes:
            item["escapes"] = True
        items.append(item)
    # tau's order: directories first, then A→Z
    items.sort(key=lambda i: (not i["isDirectory"], i["name"].lower()))
    return {
        "root": root,
        "path": d,
        "items": items[:FS_LIST_CAP],
        "truncated": len(items) > FS_LIST_CAP,
        "cap": FS_LIST_CAP,
    }


def fs_file(qs):
    root = fs_root(qs)
    abs_, real = fs_path(root, (qs.get("path") or [""])[0])
    if not real:
        raise FsError(404, "no such file: %s" % abs_)
    if not os.path.isfile(real):
        raise FsError(400, "not a file: %s (use /oc/fs/list)" % abs_)
    size = os.path.getsize(real)
    if size > FS_FILE_BYTES:
        return {"path": abs_, "size": size, "type": "too_large", "truncated": True}
    with open(real, "rb") as fh:
        buf = fh.read()
    mime = FS_IMAGE.get(os.path.splitext(abs_)[1].lower())
    if mime:
        return {"path": abs_, "size": size, "type": "image", "mime": mime, "base64": base64.b64encode(buf).decode()}
    # NUL => binary. No body at all: base64 of a blob on every click is not a
    # preview, and the drawer has nothing to draw with it.
    if b"\0" in buf:
        return {"path": abs_, "size": size, "type": "binary"}
    return {"path": abs_, "size": size, "type": "text", "content": buf.decode("utf-8", "replace")}


def fs_find(qs):
    root = fs_root(qs)
    needle = (qs.get("q") or [""])[0].strip().lower()
    if not needle:
        raise FsError(400, "q is required")
    matches = []
    truncated = False
    queue = [(root, 0)]
    while queue and not truncated:
        d, depth = queue.pop(0)
        try:
            scan = list(os.scandir(d))
        except OSError:
            continue  # raced away or unreadable: skip the subtree, do not fail the search
        for e in scan:
            if fs_hidden(e.name):
                continue
            depth1 = depth + 1
            try:
                is_dir = e.is_dir(follow_symlinks=False)
            except OSError:
                continue
            if e.is_symlink():
                # NAMES are searchable through a link, but a link is never
                # WALKED: that is the one way a search could leave the ceiling.
                t = os.path.realpath(e.path)
                if not fs_within(t, FS_CEILING):
                    continue
                if depth1 <= FS_MAX_DEPTH and needle in e.name.lower():
                    matches.append({"name": e.name, "path": e.path, "isDirectory": False, "symlink": True})
                continue
            if depth1 <= FS_MAX_DEPTH and needle in e.name.lower():
                matches.append({"name": e.name, "path": e.path, "isDirectory": is_dir})
            if is_dir and depth1 < FS_MAX_DEPTH:
                queue.append((e.path, depth1))
            if len(matches) >= FS_FIND_CAP:
                truncated = True
                break
    return {"root": root, "matches": matches, "truncated": truncated, "cap": FS_FIND_CAP, "depth": FS_MAX_DEPTH}


def porcelain_status(xy):
    """`M ` (staged) and ` M` (worktree) collapse to ONE word: the drawer badges
    "this file is dirty", and whether the change happens to be staged is
    somebody else's business in a shared worktree."""
    x, y = xy[0], xy[1]
    if xy == "??":
        return "untracked"
    if x == "U" or y == "U":
        return "conflicted"
    if x == "R" or y == "R":
        return "renamed"
    if x == "C" or y == "C":
        return "copied"
    if x == "D" or y == "D":
        return "deleted"
    if x == "A":
        return "added"
    if x == "T" or y == "T":
        return "typechange"
    return "modified"


def parse_porcelain_z(out, top):
    """porcelain v1 with -z: NUL-separated `XY path` records, and a rename/copy
    inserts the SOURCE as the next field."""
    fields = out.split("\0")
    dirty = []
    i = 0
    while i < len(fields):
        rec = fields[i]
        i += 1
        if len(rec) < 4:
            continue
        xy, rel = rec[:2], rec[3:]
        if not rel:
            continue
        if xy[0] in ("R", "C") or xy[1] in ("R", "C"):
            i += 1  # skip the source field
        rel = rel.lstrip("./")
        dirty.append({"path": rel, "abs": os.path.join(top, rel), "status": porcelain_status(xy), "xy": xy})
    return dirty


def fs_status(qs):
    root = fs_root(qs)
    top = (git_out(root, ["rev-parse", "--show-toplevel"]) or "").strip() or None
    if not top:
        return {"root": root, "repo": False, "dirty": []}  # not a repo: plain tree, no error tile
    raw = git_out(top, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
    head = (git_out(top, ["rev-parse", "--short", "HEAD"]) or "").strip() or None
    branch = (git_out(top, ["rev-parse", "--abbrev-ref", "HEAD"]) or "").strip() or None
    base = {"root": root, "repo": True, "toplevel": top, "head": head, "branch": branch}
    if raw is None:
        return {**base, "dirty": [], "error": "git status failed"}
    all_ = parse_porcelain_z(raw, top)
    if len(all_) > FS_STATUS_CAP:
        # Refuse rather than ship 200k rows the drawer cannot draw: a truncated
        # dirty set would silently un-badge files, worse than saying no.
        return {
            **base, "dirty": [], "truncated": True, "cap": FS_STATUS_CAP,
            "error": "%d changed files exceed the %d-entry cap" % (len(all_), FS_STATUS_CAP),
        }
    # A repo may reach ABOVE the ceiling (a cwd one level inside it). Then the
    # dirty set is cut at the ceiling: those files are unreadable here anyway,
    # and naming them would leak what the containment rule exists to hide.
    dirty = [d for d in all_ if fs_within(d["abs"], FS_CEILING)]
    scoped = len(dirty) != len(all_)
    out = {**base, "dirty": dirty, "scoped": scoped, "truncated": False}
    if scoped:
        out["omitted"] = len(all_) - len(dirty)
    return out


def fs_diff(qs):
    root = fs_root(qs)
    abs_, real = fs_path(root, (qs.get("path") or [""])[0])
    top = (git_out(root, ["rev-parse", "--show-toplevel"]) or "").strip() or None
    if not top:
        raise FsError(400, "not a git repository: %s" % root)
    rel = os.path.relpath(abs_, top)
    if not rel or rel.startswith("..") or os.path.isabs(rel):
        raise FsError(403, "%s is outside the git repository at %s" % (abs_, top))
    body = git_out(top, ["diff", "--no-color", "-U3", "HEAD", "--", rel])
    if body is None:
        raise FsError(400, "git diff failed for %s" % rel)
    patch = body
    untracked = False
    if not patch.strip():
        in_head = git_out(top, ["cat-file", "-e", "HEAD:%s" % rel]) is not None
        if not in_head and real and os.path.isfile(real):
            # No HEAD side at all: synthesize all-adds.
            untracked = True
            with open(real, "r", errors="replace") as fh:
                lines = fh.read().rstrip("\n").split("\n")
            patch = "--- /dev/null\n+++ b/%s\n@@ -0,0 +1,%d @@\n" % (rel, len(lines)) + "\n".join("+" + l for l in lines)
    truncated = len(patch) > FS_DIFF_BYTES
    return {
        "root": root, "toplevel": top, "path": abs_, "rel": rel,
        "patch": patch[:FS_DIFF_BYTES] if truncated else patch,
        "truncated": truncated, "untracked": untracked,
    }


FS_ROUTES = {"list": fs_list, "file": fs_file, "find": fs_find, "status": fs_status, "diff": fs_diff}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "opencode-chatserver/0.2"

    def log_message(self, fmt, *args):
        pass

    def _apply_security(self, nonce):
        # Strict CSP. Scripts are locked to same-origin + this nonce (no inline
        # scripts can execute). 'wasm-unsafe-eval' is the narrow directive that
        # permits WebAssembly.compile/instantiate — the webui's .scad viewer
        # compiles OpenSCAD in a worker — without allowing eval() in JS. Styles
        # allow 'unsafe-inline' because Svelte component style: directives
        # compile to inline style= attributes; the CSS-injection defense lives
        # in DOMPurify (FORBID_TAGS/FORBID_ATTR ['style']), which strips every
        # style= from untrusted message content.
        csp = (
            "default-src 'none'; "
            "script-src 'self' 'nonce-{nonce}' 'wasm-unsafe-eval'; "
            "style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; "
            "font-src 'self'; "
            "connect-src 'self'; "
            "manifest-src 'self'; "
            "object-src 'none'; "
            "frame-ancestors 'none'; "
            "base-uri 'self'; "
            "form-action 'self'; "
            "trusted-types dompurify"
        ).format(nonce=nonce)
        self.send_header("Content-Security-Policy", csp)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header(
            "Permissions-Policy",
            "camera=(), microphone=(), geolocation=(), payment=(), usb=(), "
            "magnetometer=(), gyroscope=()",
        )

    # ---- helpers ---------------------------------------------------------
    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        nonce = secrets.token_urlsafe(32)
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        # On-the-fly gzip for large payloads (patch-heavy /changes responses
        # shrink ~8x); statics use precompressed siblings instead.
        if len(body) > 1024 and "gzip" in (self.headers.get("Accept-Encoding") or ""):
            body = gzip.compress(body, 6)
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._apply_security(nonce)
        self.end_headers()
        self.wfile.write(body)

    def send_text(self, text, code=200, ctype="text/plain; charset=utf-8"):
        body = text.encode()
        nonce = secrets.token_urlsafe(32)
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self._apply_security(nonce)
        self.end_headers()
        self.wfile.write(body)

    # ---- routing -----------------------------------------------------------
    def do_GET(self):
        u = urlparse(self.path)
        path = u.path
        try:
            if path == "/healthz":
                return self.send_json({"ok": True})
            if self.command == "GET" and path == "/oc/workspaces":
                return self.send_json(
                    {"root": workspace_root(), "chips": workspace_chips()}
                )
            if self.command == "GET" and path == "/oc/fs/dirs":
                prefix = (parse_qs(u.query).get("prefix") or [""])[0]
                return self.send_json({"items": complete_directories(prefix)})
            # File browser drawer (docs/file-browser.md). Local, NOT proxied:
            # the engine serves none of these routes.
            m = re.match(r"^/oc/fs/(list|file|find|status|diff)$", path)
            if m and self.command == "GET":
                try:
                    return self.send_json(FS_ROUTES[m.group(1)](parse_qs(u.query)))
                except FsError as e:
                    return self.send_json({"error": str(e)}, e.status)
            if path == "/api/history/sessions":
                return self.send_json(load_sessions())
            if path == "/api/history/errors":
                return self.send_json(session_errors_all())
            m = re.match(r"^/api/history/session/([^/]+)/changes$", path)
            if m:
                changes = session_changes(m.group(1))
                if changes is None:
                    return self.send_json({"error": "unknown session"}, 404)
                return self.send_json(changes)
            m = re.match(r"^/api/history/session/([^/]+)/errors$", path)
            if m:
                sid = m.group(1)
                if self.command == "POST":
                    length = int(self.headers.get("Content-Length") or 0)
                    try:
                        body = json.loads(self.rfile.read(length) or b"{}")
                    except ValueError:
                        return self.send_json({"error": "bad json"}, 400)
                    msg = str(body.get("message") or "").strip()
                    if not msg:
                        return self.send_json({"error": "message required"}, 400)
                    return self.send_json(session_error_add(sid, msg, body.get("t")))
                if self.command == "DELETE":
                    return self.send_json(session_error_clear(sid))
                return self.send_json(session_errors(sid))
            m = re.match(r"^/api/history/session/([^/]+)/meta$", path)
            if m:
                sid = m.group(1)
                if self.command in ("PUT", "POST"):
                    length = int(self.headers.get("Content-Length") or 0)
                    try:
                        body = json.loads(self.rfile.read(length) or b"{}")
                    except ValueError:
                        return self.send_json({"error": "bad json"}, 400)
                    # Read current state for partial merge
                    cur = _session_meta_get(sid) or {"star": False, "tag": None}
                    star = cur["star"]
                    tag = cur["tag"]
                    if "star" in body and isinstance(body["star"], bool):
                        star = body["star"]
                    if "tag" in body:
                        t = body["tag"]
                        if isinstance(t, str):
                            t = t.strip() or None
                        elif t is None:
                            t = None
                        else:
                            # ignore wrong types — keep existing
                            t = tag
                        tag = t
                    result = session_meta_write(sid, star, tag)
                    return self.send_json({"ok": True, **result})
                if self.command == "DELETE":
                    return self.send_json(session_meta_delete(sid))
                # GET
                cur = _session_meta_get(sid)
                return self.send_json(cur or {"star": False, "tag": None})
            if path.startswith("/api/history/session/"):
                sid = path.rsplit("/", 1)[1]
                limit = None
                try:
                    limit = min(int(parse_qs(u.query).get("limit", [""])[0]), 2000)
                    if limit <= 0:
                        limit = None
                except ValueError:
                    pass
                msgs = load_messages(sid, limit)
                if msgs is None:
                    return self.send_json({"error": "unknown session"}, 404)
                return self.send_json(msgs)
            if path == "/api/search":
                q = parse_qs(u.query).get("q", [""])[0]
                return self.send_json(search(q))
            if path.startswith("/api/"):
                return self.send_json({"error": "not found"}, 404)
            if path.startswith("/oc/") or path == "/oc":
                try:
                    return self.proxy(u)
                except (BrokenPipeError, ConnectionResetError):
                    raise
                except Exception:
                    # Engine unreachable (refused / timed out), possibly after
                    # the SSE response already started. A non-2xx answer to
                    # GET /oc/event is FATAL: per the EventSource spec the
                    # browser "fails the connection" on any non-200 or
                    # wrong-MIME response and never reconnects — the webui
                    # would go dark until a page reload. Closing with no
                    # response reads as a network error instead, which IS
                    # retryable (the browser re-issues the request). All
                    # other /oc requests keep the 500 JSON body below.
                    if u.path.rstrip("/") == "/oc/event":
                        self.close_connection = True
                        return
                    raise
            return self.static(path)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            try:
                self.send_json({"error": str(e)}, 500)
            except Exception:
                pass

    do_POST = do_GET
    do_DELETE = do_GET
    do_PUT = do_GET
    do_PATCH = do_GET

    # ---- proxy (streaming, SSE-safe) ---------------------------------------
    def proxy(self, u):
        target = urlunparse(("http", OC_ENGINE, u.path[len("/oc") :] or "/", "", u.query, ""))
        conn = http.client.HTTPConnection(OC_ENGINE, timeout=600)
        headers = {
            k: v
            for k, v in self.headers.items()
            if k.lower() not in ("host", "connection", "accept-encoding", "content-length")
        }
        headers["Accept-Encoding"] = "identity"
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        # pi's `cwd` (sent once the /oc/workspaces probe passed) is not a
        # field the engine accepts — drop it, or POST /session 400s on
        # additionalProperties:false. The response's own `directory` tells
        # the webui where the session really landed.
        if body and self.command == "POST" and u.path == "/oc/session":
            try:
                parsed = json.loads(body)
            except ValueError:
                parsed = None
            if isinstance(parsed, dict) and "cwd" in parsed:
                parsed.pop("cwd")
                body = json.dumps(parsed).encode()
        try:
            conn.request(self.command, target, body=body, headers=headers)
            resp = conn.getresponse()

            self.send_response(resp.status)
            for k, v in resp.getheaders():
                if k.lower() in ("transfer-encoding", "connection", "keep-alive"):
                    continue
                self.send_header(k, v)
            cl = resp.getheader("Content-Length")
            if cl is None:
                self.send_header("Connection", "close")
                self.close_connection = True
            self.end_headers()

            # read1 returns as soon as ANY bytes arrive -> SSE-safe
            reader = getattr(resp, "read1", None) or resp.read
            while True:
                chunk = reader(8192)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        finally:
            conn.close()

    # ---- static ------------------------------------------------------------
    def static(self, path):
        # Serves the dist at both routes: root-base builds (the default) answer
        # directly, and a '/webui/...' request is stripped so the same directory
        # also works under subpath hosting (WEBUI_BASE=/webui/) and for old links.
        if path == "/webui" or path.startswith("/webui/"):
            path = path[len("/webui"):] or "/"
        if path == "/" or "." not in os.path.basename(path):
            path = "/index.html"
        full = os.path.realpath(WEBUI_DIST + path)
        if not full.startswith(WEBUI_DIST + os.sep) and full != os.path.join(WEBUI_DIST, "index.html"):
            return self.send_text("forbidden", 403)
        if not os.path.isfile(full):
            return self.send_text("dist missing — run: cd webui && npm run build", 500)

        st = os.stat(full)
        etag = '"%x-%x"' % (st.st_mtime_ns, st.st_size)
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        # HTML carries the per-request CSP nonce, so it can never be answered
        # with a 304: the browser would reuse its cached body (old nonce) under
        # the fresh CSP header and block the inline theme <script>. Serve it
        # whole every time (it's ~1.5 KB). Hashed asset filenames are
        # content-addressed -> cache forever; everything else revalidates.
        html = ctype == "text/html"
        immutable = path.startswith("/assets/")
        if html:
            cache_control = "no-store"
        elif immutable:
            cache_control = "public, max-age=31536000, immutable"
        else:
            cache_control = "no-cache"

        if not html and etag in (self.headers.get("If-None-Match") or ""):
            nonce = secrets.token_urlsafe(32)
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", cache_control)
            self._apply_security(nonce)
            self.end_headers()
            return

        accept = self.headers.get("Accept-Encoding") or ""
        encoding = None
        body_path = full
        # Skip precompressed siblings for HTML — nonce replacement needs the
        # uncompressed bytes containing the ASCII placeholder string.
        if not html:
            if "br" in accept and os.path.isfile(full + ".br"):
                encoding, body_path = "br", full + ".br"
            elif "gzip" in accept and os.path.isfile(full + ".gz"):
                encoding, body_path = "gzip", full + ".gz"

        with open(body_path, "rb") as f:
            body = f.read()
        nonce = secrets.token_urlsafe(32)
        # Swap Vite's nonce placeholder for a fresh per-request nonce so the
        # strict script-src 'nonce-…' matches the inline theme <script>.
        if CSP_NONCE_PLACEHOLDER.encode() in body:
            body = body.replace(CSP_NONCE_PLACEHOLDER.encode(), nonce.encode())
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache_control)
        if not html:
            self.send_header("ETag", etag)
        self.send_header("Vary", "Accept-Encoding")
        self._apply_security(nonce)
        if encoding:
            self.send_header("Content-Encoding", encoding)
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    if not os.path.exists(OC_DB):
        raise SystemExit(f"database not found: {OC_DB}")
    try:
        _serr_connect(create=True).close()
    except Exception as e:
        print(f"webui sidecar unavailable ({e}) — error tiles won't persist", flush=True)
    # start background SSE collector (daemon thread — dies with the process)
    t = threading.Thread(target=_sse_collector, daemon=True, name="sse-collector")
    t.start()
    print(f"chatserver: sse-collector watching {OC_ENGINE}", flush=True)
    # warm the FTS index off the request path (first cold build can take seconds)
    threading.Thread(target=_fts_sync, daemon=True, name="fts-warm").start()
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"chatserver: http://{HOST}:{PORT}  dist={WEBUI_DIST}  engine={OC_ENGINE}", flush=True)
    srv.serve_forever()
