#!/usr/bin/env python3
"""opencode chat server.

Single-origin backend for the webui:
  /                -> webui/dist statics (SPA fallback to index.html)
  /oc/*            -> reverse proxy to the opencode engine (REST + SSE, streamed)
  /api/history/*   -> read-only sqlite access to opencode.db (sessions, transcript;
                      transcript accepts ?limit=N for a newest-N window)
  /api/search      -> case-insensitive substring search across all message parts
  /healthz         -> liveness

Pure stdlib. Stateless: every /api request runs its own read-only SQL against
opencode.db (WAL-safe alongside a live engine/TUI) instead of materializing
the whole database in RAM. Statics get ETag/304 revalidation, immutable
caching for hashed /assets/, and transparent .br/.gz precompressed serving.
Env: PORT(8080) HOST(0.0.0.0) OC_ENGINE(http://127.0.0.1:4096)
     OC_DB(/home/node/.local/share/opencode/opencode.db) WEBUI_DIST(./webui/dist)
"""

import gzip
import http.client
import json
import mimetypes
import os
import re
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, urlunparse

PORT = int(os.environ.get("PORT", "8080"))
HOST = os.environ.get("HOST", "0.0.0.0")
OC_DB = os.environ.get(
    "OC_DB", os.path.expanduser("~/.local/share/opencode/opencode.db")
)
OC_ENGINE = os.environ.get("OC_ENGINE", "http://127.0.0.1:4096").replace("http://", "")
WEBUI_DIST = os.path.abspath(
    os.environ.get("WEBUI_DIST", os.path.join(os.path.dirname(__file__), "webui", "dist"))
)

SNIPPET_CTX = 70
SEARCH_CAP = 300
WORKTREE = "/workspace/"


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


def _connect():
    uri = "file:%s?mode=ro" % OC_DB
    conn = sqlite3.connect(uri, uri=True, timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only=1")
    # Unicode-aware lowercase inside SQL (sqlite's lower() is ASCII-only);
    # keeps search semantics identical to the previous in-Python index.
    conn.create_function("pylower", 1, lambda s: s.lower() if s else s)
    return conn


def load_sessions():
    out = []
    with _connect() as c:
        rows = c.execute(
            """SELECT s.id, s.title, s.cost, s.model, s.parent_id, s.agent, s.time_created tc,
                      s.time_updated tu, COUNT(m.id) n
               FROM session s LEFT JOIN message m ON m.session_id = s.id
               GROUP BY s.id ORDER BY s.rowid DESC"""
        )
        for r in rows:
            model = r["model"] or ""
            if isinstance(model, str) and model.startswith("{"):
                try:
                    model = json.loads(model).get("id") or ""
                except Exception:
                    model = ""
            created = num(r["tc"])
            out.append(
                {
                    "id": r["id"],
                    "title": r["title"] or "",
                    "cost": float(r["cost"] or 0),
                    "model": model,
                    "parent": r["parent_id"] or "",
                    "agent": r["agent"] or "",
                    "created": created,
                    "updated": num(r["tu"]) or created,
                    "message_count": r["n"],
                }
            )
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
                    "state_summary": summary[:120],
                }
            )
    return msgs


def search(q):
    ql = q.lower().strip()
    if len(ql) < 2:
        return []
    hits = []
    with _connect() as c:
        titles = {
            r["id"]: r["title"] or r["id"][:12]
            for r in c.execute("SELECT id, title FROM session")
        }
        cur = c.execute(
            """SELECT p.id pid, p.message_id mid, p.session_id sid,
                      json_extract(p.data, '$.text') txt,
                      COALESCE(json_extract(m.data, '$.role'), 'assistant') role
               FROM part p
               JOIN message m ON m.id = p.message_id AND m.session_id = p.session_id
               WHERE json_extract(p.data, '$.type') = 'text'
                 AND json_extract(p.data, '$.text') IS NOT NULL
                 AND instr(pylower(CAST(json_extract(p.data, '$.text') AS TEXT)), ?) > 0
               ORDER BY p.time_created""",
            (ql,),
        )
        for r in cur:
            low = r["txt"].lower()
            i = low.find(ql)
            a = max(0, i - SNIPPET_CTX)
            b = min(len(low), i + len(ql) + SNIPPET_CTX)
            snippet = ("…" if a > 0 else "") + low[a:b].replace("\n", " ") + (
                "…" if b < len(low) else ""
            )
            hits.append(
                {
                    "session_id": r["sid"],
                    "session_title": titles.get(r["sid"], r["sid"][:12]),
                    "message_id": r["mid"],
                    "part_id": r["pid"],
                    "role": r["role"],
                    "snippet": snippet,
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


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "opencode-chatserver/0.2"

    def log_message(self, fmt, *args):
        pass

    # ---- helpers ---------------------------------------------------------
    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        # On-the-fly gzip for large payloads (patch-heavy /changes responses
        # shrink ~8x); statics use precompressed siblings instead.
        if len(body) > 1024 and "gzip" in (self.headers.get("Accept-Encoding") or ""):
            body = gzip.compress(body, 6)
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_text(self, text, code=200, ctype="text/plain; charset=utf-8"):
        body = text.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ---- routing -----------------------------------------------------------
    def do_GET(self):
        u = urlparse(self.path)
        path = u.path
        try:
            if path == "/healthz":
                return self.send_json({"ok": True})
            if path == "/api/history/sessions":
                return self.send_json(load_sessions())
            m = re.match(r"^/api/history/session/([^/]+)/changes$", path)
            if m:
                changes = session_changes(m.group(1))
                if changes is None:
                    return self.send_json({"error": "unknown session"}, 404)
                return self.send_json(changes)
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
                return self.proxy(u)
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
        if path == "/" or "." not in os.path.basename(path):
            path = "/index.html"
        full = os.path.realpath(WEBUI_DIST + path)
        if not full.startswith(WEBUI_DIST + os.sep) and full != os.path.join(WEBUI_DIST, "index.html"):
            return self.send_text("forbidden", 403)
        if not os.path.isfile(full):
            return self.send_text("dist missing — run: cd webui && npm run build", 500)

        st = os.stat(full)
        etag = '"%x-%x"' % (st.st_mtime_ns, st.st_size)
        # Hashed asset filenames are content-addressed -> cache forever;
        # index.html must always revalidate so new deploys are picked up.
        immutable = path.startswith("/assets/")
        cache_control = "public, max-age=31536000, immutable" if immutable else "no-cache"

        if etag in (self.headers.get("If-None-Match") or ""):
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", cache_control)
            self.end_headers()
            return

        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        accept = self.headers.get("Accept-Encoding") or ""
        encoding = None
        body_path = full
        if "br" in accept and os.path.isfile(full + ".br"):
            encoding, body_path = "br", full + ".br"
        elif "gzip" in accept and os.path.isfile(full + ".gz"):
            encoding, body_path = "gzip", full + ".gz"

        with open(body_path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache_control)
        self.send_header("ETag", etag)
        self.send_header("Vary", "Accept-Encoding")
        if encoding:
            self.send_header("Content-Encoding", encoding)
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    if not os.path.exists(OC_DB):
        raise SystemExit(f"database not found: {OC_DB}")
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"chatserver: http://{HOST}:{PORT}  dist={WEBUI_DIST}  engine={OC_ENGINE}", flush=True)
    srv.serve_forever()
