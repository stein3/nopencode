#!/usr/bin/env python3
"""opencode chat server.

Single-origin backend for the webui:
  /                -> webui/dist statics (SPA fallback to index.html)
  /oc/*            -> reverse proxy to the opencode engine (REST + SSE, streamed)
  /api/history/*   -> read-only sqlite access to opencode.db (sessions, transcript)
  /api/search      -> case-insensitive substring search across all message parts
  /healthz         -> liveness

Pure stdlib. Read-only against the DB; safe alongside a live engine/TUI (WAL).
Env: PORT(8080) HOST(0.0.0.0) OC_ENGINE(http://127.0.0.1:4096)
     OC_DB(/home/node/.local/share/opencode/opencode.db) WEBUI_DIST(./webui/dist)
"""

import http.client
import json
import mimetypes
import os
import sqlite3
import threading
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


class Store:
    def __init__(self, db_path):
        self.db_path = db_path
        self.lock = threading.Lock()
        self.stamp = None
        self.sessions = []          # [{id,title,cost,model,created,updated,msgs}]
        self.msgs = {}              # sid -> [msg dict] each with .parts
        self.text_index = []        # (sid, mid, pid, role, lower(text))

    # ---- loading -------------------------------------------------------
    def _fresh(self):
        stamps = []
        for suffix in ("", "-wal"):
            try:
                stamps.append(os.stat(self.db_path + suffix).st_mtime_ns)
            except FileNotFoundError:
                pass
        return tuple(stamps)

    def refresh(self):
        cur = self._fresh()
        with self.lock:
            if cur == self.stamp:
                return
            s, m, t = self._load()
            self.sessions, self.msgs, self.text_index = s, m, t
            self.stamp = cur

    def _connect(self):
        uri = "file:%s?mode=ro" % self.db_path
        conn = sqlite3.connect(uri, uri=True, timeout=5)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA query_only=1")
        return conn

    def _load(self):
        sessions, msgs_by_sid, text_index = [], {}, []
        counts = {}
        with self._connect() as c:
            try:
                for r in c.execute(
                    "SELECT session_id, COUNT(*) n FROM message GROUP BY session_id"
                ):
                    counts[r["session_id"]] = r["n"]
            except sqlite3.Error:
                pass

            for r in c.execute("SELECT * FROM session ORDER BY rowid DESC"):
                d = dict(r)
                sid = d.get("id")
                model = d.get("model") or ""
                if isinstance(model, str) and model.startswith("{"):
                    try:
                        model = json.loads(model).get("id") or ""
                    except Exception:
                        model = ""
                sessions.append(
                    {
                        "id": sid,
                        "title": d.get("title") or "",
                        "cost": float(d.get("cost") or 0),
                        "model": model,
                        "created": num(d.get("time_created")),
                        "updated": num(d.get("time_updated")) or num(d.get("time_created")),
                        "message_count": counts.get(sid, 0),
                    }
                )
            sid_set = {s["id"] for s in sessions}

            for mr in c.execute(
                "SELECT id, session_id, data FROM message ORDER BY time_created"
            ):
                md = json.loads(mr["data"] or "{}")
                mid, sid = mr["id"], mr["session_id"]
                if sid not in sid_set:
                    continue
                msgs_by_sid.setdefault(sid, []).append(
                    {
                        "id": mid,
                        "role": md.get("role", "assistant"),
                        "agent": (md.get("agent") or "") or None,
                        "modelID": ((md.get("model") or {}).get("modelID")) or None,
                        "time": num((md.get("time") or {}).get("created")),
                        "parts": [],
                        "_sid": sid,
                    }
                )

            pos = {(m["_sid"], m["id"]): m for lst in msgs_by_sid.values() for m in lst}
            for pr in c.execute(
                "SELECT id, message_id, session_id, data FROM part ORDER BY time_created"
            ):
                pd = json.loads(pr["data"] or "{}")
                m = pos.get((pr["session_id"], pr["message_id"]))
                if not m:
                    continue
                ptype = pd.get("type", "")
                text = pd.get("text")
                tool = pd.get("tool") or pd.get("toolName") or (
                    ptype if ptype not in ("text",) else ""
                )
                state = pd.get("state") or {}
                summary = state.get("status") or state.get("title") or ""
                m["parts"].append(
                    {
                        "id": pr["id"],
                        "type": ptype,
                        "text": text,
                        "tool": tool or None,
                        "state_summary": summary[:120],
                    }
                )
                if text and ptype == "text":
                    text_index.append(
                        (pr["session_id"], m["id"], pr["id"], m["role"], text.lower())
                    )
        return sessions, msgs_by_sid, text_index


STORE = Store(OC_DB)


def search(q):
    ql = q.lower().strip()
    if len(ql) < 2:
        return []
    titles = {s["id"]: s["title"] or s["id"][:12] for s in STORE.sessions}
    hits = []
    for sid, mid, pid, role, low in STORE.text_index:
        i = low.find(ql)
        if i == -1:
            continue
        a = max(0, i - SNIPPET_CTX)
        b = min(len(low), i + len(ql) + SNIPPET_CTX)
        snippet = ("…" if a > 0 else "") + low[a:b].replace("\n", " ") + ("…" if b < len(low) else "")
        hits.append(
            {
                "session_id": sid,
                "session_title": titles.get(sid, sid[:12]),
                "message_id": mid,
                "part_id": pid,
                "role": role,
                "snippet": snippet,
            }
        )
        if len(hits) >= SEARCH_CAP:
            break
    return hits


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "opencode-chatserver/0.1"

    def log_message(self, fmt, *args):
        pass

    # ---- helpers ---------------------------------------------------------
    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
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
            STORE.refresh()
            if path == "/healthz":
                return self.send_json({"ok": True})
            if path == "/api/history/sessions":
                return self.send_json(STORE.sessions)
            if path.startswith("/api/history/session/"):
                sid = path.rsplit("/", 1)[1]
                msgs = STORE.msgs.get(sid)
                if msgs is None:
                    return self.send_json({"error": "unknown session"}, 404)
                out = [{k: v for k, v in m.items() if k != "_sid"} for m in msgs]
                return self.send_json(out)
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
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        with open(full, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    if not os.path.exists(OC_DB):
        raise SystemExit(f"database not found: {OC_DB}")
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"chatserver: http://{HOST}:{PORT}  dist={WEBUI_DIST}  engine={OC_ENGINE}", flush=True)
    srv.serve_forever()
