#!/usr/bin/env python3
"""Regression check: chatserver's per-session token projection.

The webui sidebar row shows GENERATED tokens = output + reasoning summed over a
session's assistant messages (`tokens_generated`), and it is SELF-ONLY — the
webui adds subagent sessions itself. This check pins the server half:

  * assistant usage is summed across ALL messages, and `reasoning` counts;
  * user-role message usage is NOT counted;
  * input / cache.read / cache.write are NOT counted (95.6-99.5% of real raw
    volume is cache reads — a raw sum measures turns, not work);
  * `tokens` stays the separate newest-message context estimate;
  * an all-zero usage record emits neither key.

Self-contained: builds a throwaway sqlite DB with the engine's schema, points
OC_DB at it, imports chatserver, and calls load_sessions() directly (no server,
no engine).

  python3 e2e/chatserver-tokens-check.py            # current tree
  OC_CHECK_SCRIPT=/path/to/older/chatserver.py \\    # prove it fails pre-fix
      python3 e2e/chatserver-tokens-check.py
"""
import importlib.util
import json
import os
import sqlite3
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.environ.get("OC_CHECK_SCRIPT") or os.path.join(HERE, "..", "chatserver.py")

fails = 0


def check(ok, label, note=""):
    global fails
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}" + (f" — {note}" if note else ""))
    if not ok:
        fails += 1


def tok(**kw):
    return {
        "input": kw.get("input", 0),
        "output": kw.get("output", 0),
        "reasoning": kw.get("reasoning", 0),
        "cache": {"read": kw.get("cache_read", 0), "write": kw.get("cache_write", 0)},
    }


tmp = tempfile.mkdtemp(prefix="oc-tokcheck-")
db = os.path.join(tmp, "opencode.db")
c = sqlite3.connect(db)
c.executescript(
    """
CREATE TABLE session (
  id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, version TEXT, agent TEXT,
  directory TEXT, model TEXT, cost REAL,
  tokens_input INT, tokens_output INT, tokens_reasoning INT,
  tokens_cache_read INT, tokens_cache_write INT,
  time_created INT, time_updated INT);
CREATE TABLE message (
  id TEXT PRIMARY KEY, session_id TEXT, time_created INT, time_updated INT, data TEXT);
CREATE INDEX message_session_time_created_id_idx ON message(session_id, time_created, id);
"""
)
NOW = 1_700_000_000_000
sessions = [
    # id, parent, title, session-level rollup columns (deliberately left ZERO:
    # the projection must compute from messages, not read the engine rollup)
    ("ses_parent", None, "tokens-check parent", 0, 0, 0, 0, 0),
    ("ses_child", "ses_parent", "tokens-check child", 0, 0, 0, 0, 0),
    ("ses_zero", None, "tokens-check zero", 0, 0, 0, 0, 0),
]
for sid, parent, title, ti, to, tr, tcr, tcw in sessions:
    c.execute(
        "INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (sid, parent, title, "v1", "build", "/workspace", '{"id":"m1","providerID":"p"}',
         0.0, ti, to, tr, tcr, tcw, NOW, NOW),
    )

msgs = [
    # parent: two assistant turns -> generated = (120+30) + (80+0) = 230
    #         context estimate (newest) = 6000+80+0+1500 = 7580
    ("m1", "ses_parent", NOW + 1, {"role": "user", "tokens": tok(output=999)}),
    ("m2", "ses_parent", NOW + 2,
     {"role": "assistant", "tokens": tok(input=5000, output=120, reasoning=30, cache_read=9000)}),
    ("m3", "ses_parent", NOW + 3,
     {"role": "assistant", "tokens": tok(input=6000, output=80, cache_read=1500)}),
    # child: one assistant turn -> 2500; must stay separate from the parent
    ("m4", "ses_child", NOW + 4,
     {"role": "assistant", "tokens": tok(input=40000, output=2000, reasoning=500, cache_read=80000)}),
    # zero: provider-silent turn -> no keys at all
    ("m5", "ses_zero", NOW + 5, {"role": "assistant", "tokens": tok()}),
]
for mid, sid, t, data in msgs:
    c.execute("INSERT INTO message VALUES (?,?,?,?,?)", (mid, sid, t, t + 1, json.dumps(data)))
c.commit()
c.close()

os.environ["OC_DB"] = db
os.environ["OC_WEBUI_DB"] = os.path.join(tmp, "webui.db")

spec = importlib.util.spec_from_file_location("chatserver_under_test", SCRIPT)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

rows = {r["id"]: r for r in mod.load_sessions()}
check(set(rows) >= {"ses_parent", "ses_child", "ses_zero"}, "all fixture sessions projected", str(sorted(rows)))
p, k, z = rows.get("ses_parent"), rows.get("ses_child"), rows.get("ses_zero")
if p:
    check(p.get("tokens_generated") == 230, "generated sums output+reasoning over every assistant msg",
          f'got {p.get("tokens_generated")}, want 230')
    check(p.get("tokens") == 7580, "tokens stays the newest-message context estimate",
          f'got {p.get("tokens")}, want 7580')
    check(p.get("tokens_generated") != p.get("tokens"), "the two fields are distinct numbers",
          f'{p.get("tokens_generated")} vs {p.get("tokens")}')
    check(p.get("message_count") == 3, "message_count unaffected", str(p.get("message_count")))
if k:
    check(k.get("tokens_generated") == 2500, "subagent total is SELF-ONLY (2000+500, not folded into parent)",
          f'got {k.get("tokens_generated")}, want 2500')
    check(k.get("parent") == "ses_parent", "parent link preserved for the webui rollup", str(k.get("parent")))
if z:
    check("tokens_generated" not in z, "all-zero usage emits no tokens_generated key",
          json.dumps(z.get("tokens_generated")))
    check("tokens" not in z, "all-zero usage emits no tokens key", json.dumps(z.get("tokens")))

print("\nchatserver-tokens-check:", "FAILED (%d)" % fails if fails else "ok")
sys.exit(1 if fails else 0)
