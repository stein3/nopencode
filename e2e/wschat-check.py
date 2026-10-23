#!/usr/bin/env python3
"""chatserver workspace endpoints — offline smoke check.

Boots chatserver.py on a free port against the real opencode engine + opencode.db
(read-only), then asserts the four things the webui's workspace feature needs:

  1. GET /oc/workspaces        -> well-shaped {root, chips[{name,path}]}
  2. GET /oc/fs/dirs?prefix=   -> type-ahead items under the root
  3. GET /api/history/sessions -> entries carry cwd (sidebar group key)
  4. POST /oc/session {cwd}    -> 200 with cwd stripped (engine rejects the
                                  field), session lands in the engine's own
                                  directory, then is deleted again

Usage:  python3 e2e/wschat-check.py
Needs a running engine on OC_ENGINE (default 127.0.0.1:4096).
"""
import http.client
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINE = os.environ.get("OC_ENGINE", "127.0.0.1:4096")
fails = []


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  {detail}" if detail else ""))
    if not ok:
        fails.append(label)


def get(port, path):
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=20) as r:
        return r.status, json.loads(r.read() or b"{}")


def engine(method, path, body=None):
    conn = http.client.HTTPConnection(ENGINE.split(":")[0], int(ENGINE.split(":")[1]), timeout=30)
    conn.request(method, path, body=json.dumps(body) if body is not None else None,
                 headers={"Content-Type": "application/json"})
    r = conn.getresponse()
    return r.status, json.loads(r.read() or b"{}")


def main():
    # engine must be reachable before anything else
    try:
        code, path_info = engine("GET", "/path")
    except Exception as e:
        print(f"SKIP  engine not reachable at {ENGINE}: {e}")
        return 1
    root = path_info.get("directory") or ""

    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()

    env = {**os.environ, "PORT": str(port), "HOST": "127.0.0.1",
           "OC_ENGINE": ENGINE, "WEBUI_DIST": os.path.join(REPO, "webui", "dist")}
    proc = subprocess.Popen([sys.executable, os.path.join(REPO, "chatserver.py")],
                            env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        for _ in range(100):
            try:
                if get(port, "/healthz")[0] == 200:
                    break
            except Exception:
                time.sleep(0.1)
        else:
            print("FAIL  chatserver never became healthy")
            return 1

        # 1. capability endpoint (drives the picker + sidebar grouping)
        code, ws = get(port, "/oc/workspaces")
        chips = ws.get("chips")
        check("workspaces shape", code == 200 and isinstance(ws.get("root"), str)
              and isinstance(chips, list) and all(
                  isinstance(c, dict) and c.get("name") and c.get("path") for c in chips)
              and len(chips) >= 1, json.dumps(ws)[:160])
        check("root is the engine directory", ws.get("root") == root, f"{ws.get('root')} vs {root}")

        # 2. type-ahead: prefix = the root itself lists its child dirs
        code, dirs = get(port, "/oc/fs/dirs?prefix=" + urllib.parse.quote(root + "/"))
        items = dirs.get("items") or []
        check("fs/dirs lists children", code == 200 and isinstance(items, list) and len(items) >= 1,
              f"{len(items)} items")
        if items:
            code, dirs = get(port, "/oc/fs/dirs?prefix=" + urllib.parse.quote(items[0]["path"][: len(items[0]["path"]) - 1]))
            check("fs/dirs partial match", code == 200 and any(
                i["path"].endswith(items[0]["name"]) for i in dirs.get("items") or []),
                f"{len(dirs.get('items') or [])} items")

        # 3. sidebar group key
        code, hist = get(port, "/api/history/sessions")
        check("history sessions carry cwd", code == 200 and isinstance(hist, list)
              and hist and all(isinstance(e.get("cwd"), str) for e in hist),
              f"{len(hist)} sessions")

        # 4. cwd is accepted and stripped (engine POST /session is
        #    additionalProperties:false — a raw cwd would 400)
        code, ses = engine("POST", "/session", {"title": "wschat-check"})
        sid = ses.get("id")
        check("engine accepts cwd-stripped create", code == 200 and bool(sid), f"{code} {sid}")
        if sid:
            try:
                conn = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
                conn.request("POST", "/oc/session",
                             body=json.dumps({"title": "wschat-check", "cwd": "/nonexistent/dir"}),
                             headers={"Content-Type": "application/json"})
                r = conn.getresponse()
                body = json.loads(r.read() or b"{}")
                check("POST /oc/session with cwd -> 200", r.status == 200 and body.get("id"),
                      f"{r.status} {json.dumps(body)[:120]}")
                if body.get("id"):
                    check("created session reports its real directory",
                          bool(body.get("directory")), str(body.get("directory")))
                    engine("DELETE", "/session/" + body["id"])
            finally:
                engine("DELETE", "/session/" + sid)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
    print(f"\n{'FAIL' if fails else 'OK'}: {len(fails)} failed" + (f" {fails}" if fails else ""))
    return 1 if fails else 0


if __name__ == "__main__":
    import urllib.parse
    sys.exit(main())
