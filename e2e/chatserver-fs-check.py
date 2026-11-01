#!/usr/bin/env python3
"""Regression check: chatserver's /oc/fs/* file-browser routes.

The webui's Files drawer is ONE component talking to TWO backends, so the
python half must answer with the same shapes and the same containment rules as
pi-web's /oc/fs/* (docs/file-browser.md, and web/.testbin/fsbrowse-check.mjs
holds the node half). What this pins:

  * CONTAINMENT — a cwd or path above the ceiling 403s and names the ceiling;
    `..` never walks out; a SYMLINK that points out is never followed (tau's
    rule: realpath both sides); find never walks a symlink out; a symlink that
    stays inside still works, or the rule has become a bug.
  * No global-root fallback — no cwd, or a cwd that is not a directory, answers
    4xx and lists nothing. The drawer follows the tab, never the server.
  * POLICY parity — tau's ignore set, dotfiles hidden except .env, dirs first
    then A→Z, and the caps (500 / 200 / depth 12 / 1 MiB) said out loud as
    `truncated`.
  * git is the dirty indicator, READ-ONLY: not-a-repo => {repo:false} with no
    error; `M ` and ` M` collapse to one badge word; untracked files are IN the
    set; a diff comes from HEAD so a staged edit still shows; and when the repo
    top sits ABOVE the ceiling the dirty set is cut at the ceiling rather than
    naming files this server is forbidden to read.

Self-contained: builds a throwaway tree (plus fixture git repos) in a tmp dir,
imports chatserver with OC_FS_CEILING pointed at it, and calls the route
functions directly — no server, no engine.

  python3 e2e/chatserver-fs-check.py             # current tree
  OC_CHECK_SCRIPT=/path/to/older/chatserver.py \\
      python3 e2e/chatserver-fs-check.py         # prove it fails pre-fix
"""
import importlib.util
import os
import subprocess
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


def load(tag, ceiling, status_cap=None):
    """Import chatserver with the ceiling baked into its module constants."""
    os.environ["OC_FS_CEILING"] = ceiling
    if status_cap:
        os.environ["OC_FS_STATUS_CAP"] = str(status_cap)
    spec = importlib.util.spec_from_file_location("chatserver_" + tag, SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def qsm(**kw):
    """multi-dict form, i.e. what parse_qs actually hands the handlers"""
    return {k: [str(v)] for k, v in kw.items()}


GIT_ENV = {
    **os.environ,
    "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_CONFIG_SYSTEM": "/dev/null",
    "GIT_AUTHOR_NAME": "t",
    "GIT_AUTHOR_EMAIL": "t@x",
    "GIT_COMMITTER_NAME": "t",
    "GIT_COMMITTER_EMAIL": "t@x",
    "GIT_AUTHOR_DATE": "2026-01-01T00:00:00Z",
    "GIT_COMMITTER_DATE": "2026-01-01T00:00:00Z",
}


def git(cwd, *args):
    return subprocess.run(["git", "-C", cwd] + list(args), capture_output=True, env=GIT_ENV)


# ---------------------------------------------------------------------------
# fixtures. CEIL is the ceiling; OUT is a SIBLING of SCRATCH, i.e. above it, so
# every escape assertion tests something real.
# ---------------------------------------------------------------------------
SCRATCH = os.path.realpath(tempfile.mkdtemp(prefix="oc-fscheck-"))
OUT = SCRATCH + "-outside"
CEIL = SCRATCH
BOX = os.path.join(CEIL, "box")
REPO = os.path.join(BOX, "repo")
REPO2 = os.path.join(BOX, "repo2")
SUB = os.path.join(REPO, "sub")
BOXSUB = os.path.join(BOX, "sub")


def w(p, data):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    mode = "wb" if isinstance(data, bytes) else "w"
    with open(p, mode) as fh:
        fh.write(data)


os.makedirs(BOX, exist_ok=True)
os.makedirs(OUT, exist_ok=True)
w(os.path.join(BOX, "keep.txt"), "l1\nl2\nl3\n")
w(os.path.join(BOX, ".env"), "SECRET=keepme\n")
w(os.path.join(BOX, ".hidden"), "nope\n")
w(os.path.join(BOX, "alpha.txt"), "body mentions zzzneedle in its contents\n")
w(os.path.join(BOX, "nul.bin"), b"a\x00b")
w(os.path.join(BOX, "big.txt"), "x" * (1024 * 1024 + 1))
w(os.path.join(BOX, "shot.png"), bytes.fromhex("89504e470d0a1a0a0000000d494844520000000100000001080600000"
                                               "01f15c4890000000a49444154789c63606060600000050001a5f6c"
                                               "dbf0000000049454e44ae426082"))
for d, f in [("node_modules", "junk.js"), ("dist", "app.js"), ("__pycache__", "x.pyc"), (".venv", "y.py")]:
    w(os.path.join(BOX, d, f), "junk\n")
w(os.path.join(BOXSUB, "one.txt"), "one\n")
for i in range(600):
    w(os.path.join(BOX, "many", "f%d.txt" % i), "")
for i in range(250):
    w(os.path.join(BOX, "manies", "match%d.txt" % i), "")
deep = BOX
for i in range(1, 16):
    deep = os.path.join(deep, "deepd%02d" % i)
    os.makedirs(deep, exist_ok=True)
    if i == 11:
        w(os.path.join(deep, "shallowneedle.txt"), "")
    if i == 15:
        w(os.path.join(deep, "deepneedle.txt"), "")
w(os.path.join(OUT, "secret.txt"), "ABOVE THE CEILING\n")
w(os.path.join(OUT, "secretsub.txt"), "ABOVE THE CEILING\n")
os.symlink(os.path.join(OUT, "secret.txt"), os.path.join(BOX, "link-out"))
os.symlink(OUT, os.path.join(BOX, "link-dir"))
os.symlink("../keep.txt", os.path.join(BOXSUB, "link-in"))

os.makedirs(REPO, exist_ok=True)
w(os.path.join(REPO, "a.txt"), "l1\nl2\nl3\n")
w(os.path.join(SUB, "b.txt"), "b-line\n")
w(os.path.join(REPO, "r_old.txt"), "moved me\n")
git(REPO, "init", "-q", ".")
git(REPO, "add", "-A")
git(REPO, "-c", "commit.gpgsign=false", "commit", "-qm", "init")
git(REPO, "branch", "-M", "main")
w(os.path.join(REPO, "a.txt"), "l1\nCHANGED\nl3\n")
git(REPO, "add", "a.txt")
w(os.path.join(REPO, "c.txt"), "new staged\n")
git(REPO, "add", "c.txt")
os.remove(os.path.join(SUB, "b.txt"))
w(os.path.join(REPO, "untracked.txt"), "untracked\n")
git(REPO, "mv", "-f", "r_old.txt", "r_new.txt")

os.makedirs(REPO2, exist_ok=True)
git(REPO2, "init", "-q", ".")
w(os.path.join(REPO2, "seed.txt"), "seed\n")
git(REPO2, "add", "-A")
git(REPO2, "-c", "commit.gpgsign=false", "commit", "-qm", "init")
for i in range(8):
    w(os.path.join(REPO2, "dirty%d.txt" % i), "x\n")

# ---------------------------------------------------------------------------
mod = load("ceil", CEIL, status_cap=6)
R = mod.FS_ROUTES if hasattr(mod, "FS_ROUTES") else None
if R is None:
    print("  [FAIL] chatserver exposes FS_ROUTES — the /oc/fs/* routes do not exist yet")
    print("\nFAILED 1")
    sys.exit(1)


def call(route, **kw):
    try:
        return {"status": 200, "body": R[route](qsm(**kw))}
    except mod.FsError as e:
        return {"status": e.status, "body": {"error": str(e)}}


def err(call):
    return (call["status"], call["body"].get("error", ""))


# ---- list: shape + policy --------------------------------------------------
r = call("list", cwd=BOX)
items = r["body"].get("items") if r["status"] == 200 else []
names = [i["name"] for i in items]
check(r["status"] == 200, "list answers 200 (%d)" % r["status"])
it = items[0] if items else {}
check(
    {"name", "path", "isDirectory", "size", "mtime"} <= set(it),
    "items carry name/path/isDirectory/size/mtime", repr(it)[:120],
)
check(r["body"].get("root") == BOX, "the answer names its root", repr(r["body"].get("root")))
check("keep.txt" in names and "sub" in names, "real entries are listed", ",".join(names[:6]))
for ign in ("node_modules", "dist", "__pycache__", ".venv"):
    check(ign not in names, "tau's ignore set hides %s" % ign)
check(".env" in names, ".env stays visible")
check(".hidden" not in names, "other dotfiles stay hidden")
dirs = [i["name"] for i in items if i["isDirectory"]]
check([i["isDirectory"] for i in items] == [True] * len(dirs) + [False] * (len(items) - len(dirs)),
      "directories sort before files", ",".join(dirs[:8]))
check(dirs == sorted(dirs, key=str.lower), "and names sort A→Z", ",".join(dirs))
link = next((i for i in items if i["name"] == "link-out"), {})
check(link.get("escapes") is True, "a symlink out is listed with escapes:true, not hidden", repr(link)[:120])
sub = call("list", cwd=BOX, path="sub")
check("one.txt" in [i["name"] for i in sub["body"].get("items", [])], "a relative path lists that dir")

# ---- no global-root fallback ----------------------------------------------
no = call("list")
check(400 <= no["status"] < 500 and not no["body"].get("items"),
      "no cwd answers 4xx and lists NOTHING (no server-wide root)", str(no["status"]))
dead = call("list", cwd=os.path.join(BOX, "does-not-exist"))
check(400 <= dead["status"] < 500 and "does-not-exist" in dead["body"].get("error", ""),
      "a cwd that is not a directory 400s naming it", str(err(dead))[:120])
for route in ("file", "find", "status"):
    bad = call(route, cwd=os.path.join(BOX, "does-not-exist"), path="keep.txt", q="keep")
    check(bad["status"] >= 400, "%s obeys the same rule (%d)" % (route, bad["status"]))

# ---- containment -----------------------------------------------------------
up = call("list", cwd=BOX, path="../../" + os.path.basename(OUT))
check(up["status"] == 403, "a relative path above the ceiling is 403 (%d)" % up["status"])
check(CEIL in up["body"].get("error", ""), "and the 403 names the ceiling", up["body"].get("error", "")[:140])
check(call("list", cwd=BOX, path=OUT)["status"] == 403, "an absolute path above the ceiling is 403")
check(call("list", cwd=os.path.dirname(CEIL))["status"] == 403, "a cwd ABOVE the ceiling is 403")
etc = call("file", cwd="/etc", path="passwd")
check(etc["status"] == 403 and "root:" not in str(etc["body"]), "/etc/passwd is 403, not a body", str(err(etc))[:90])
trav = call("file", cwd=BOX, path="sub/../../../%s/secret.txt" % os.path.basename(OUT))
check(trav["status"] == 403 and "ABOVE THE CEILING" not in str(trav["body"]),
      "'sub/../../..' never reads the outside file", str(err(trav))[:120])
sl = call("file", cwd=BOX, path="link-out")
check(sl["status"] == 403 and "ABOVE THE CEILING" not in str(sl["body"]),
      "a symlink pointing outside is 403 and leaks nothing", str(err(sl))[:140])
sld = call("list", cwd=BOX, path="link-dir")
check(sld["status"] == 403 and not sld["body"].get("items"), "a symlinked DIRECTORY outside is 403, lists nothing")
check(not call("find", cwd=BOX, q="secretsub")["body"].get("matches"), "find never walks a symlink out")
safe = call("file", cwd=BOX, path="sub/link-in")
check(safe["status"] == 200 and safe["body"].get("content") == "l1\nl2\nl3\n", "a symlink INSIDE the ceiling still reads")


# ---- file shapes -----------------------------------------------------------
t = call("file", cwd=BOX, path="keep.txt")
check(t["body"].get("type") == "text" and t["body"].get("content") == "l1\nl2\nl3\n", "text file -> type:text + content")
nul = call("file", cwd=BOX, path="nul.bin")
check(nul["body"].get("type") == "binary" and "content" not in nul["body"], "NUL -> type:binary, no body", repr(nul["body"])[:90])
big = call("file", cwd=BOX, path="big.txt")
check(big["body"].get("type") == "too_large" and big["body"].get("truncated") is True and big["body"].get("size", 0) > 1024 * 1024
      and "content" not in big["body"], "over 1 MiB -> too_large + size, never the string", repr(big["body"])[:110])
img = call("file", cwd=BOX, path="shot.png")
check(img["body"].get("type") == "image" and img["body"].get("base64") and "png" in str(img["body"].get("mime")),
      "an image -> base64 + mime", repr(img["body"])[:90])
check(call("file", cwd=BOX, path="nope.txt")["status"] == 404, "a missing file is 404")
check(call("file", cwd=BOX, path="sub")["status"] >= 400, "a directory via /fs/file is 4xx")

# ---- caps ------------------------------------------------------------------
many = call("list", cwd=BOX, path="many")
check(len(many["body"].get("items", [])) == 500 and many["body"].get("truncated") is True,
      "a 600-file dir lists exactly 500 and says truncated", str(len(many["body"].get("items", []))))
f = call("find", cwd=BOX, q="match")
check(len(f["body"].get("matches", [])) == 200 and f["body"].get("truncated") is True,
      "find caps at 200 and says so", str(len(f["body"].get("matches", []))))
got = [m["name"] for m in call("find", cwd=BOX, q="needle")["body"].get("matches", [])]
check("shallowneedle.txt" in got, "depth 11 is findable", ",".join(got))
check("deepneedle.txt" not in got, "depth 15 is NOT walked")
check(not call("find", cwd=BOX, q="zzzneedle")["body"].get("matches"),
      "find matches NAMES only, never contents")
check(any(m["isDirectory"] for m in call("find", cwd=BOX, q="deepd0")["body"].get("matches", [])),
      "directories are findable too")
check(not call("find", cwd=BOX, q="junk")["body"].get("matches"), "the ignore set applies to find")
check(call("find", cwd=BOX)["status"] >= 400, "find with no q is 4xx, not a full-tree walk")

# ---- git -------------------------------------------------------------------
nr = call("status", cwd=BOX)
check(nr["status"] == 200 and nr["body"].get("repo") is False and nr["body"].get("dirty") == [] and "error" not in nr["body"],
      "not a repo -> {repo:false} with NO error tile", repr(nr["body"])[:110])
s = call("status", cwd=REPO)
check(s["body"].get("repo") is True, "a repo answers repo:true")
check(len(str(s["body"].get("head") or "")) >= 7, "head is a sha", repr(s["body"].get("head")))
check(s["body"].get("branch") == "main", "branch is the branch", repr(s["body"].get("branch")))
byfile = {d["path"]: d["status"] for d in s["body"].get("dirty", [])}
check(byfile.get("a.txt") == "modified", "`M ` (staged) is ONE badge word with ` M`", repr(byfile))
check(byfile.get("c.txt") == "added", "a staged new file is added")
check(byfile.get("sub/b.txt") == "deleted", "a deleted file is deleted")
check(byfile.get("untracked.txt") == "untracked", "untracked is IN the set (-uall is the whole point)")
check(byfile.get("r_new.txt") == "renamed", "a rename reports renamed on the NEW path")
check(all(str(d.get("abs", "")).startswith(REPO) for d in s["body"].get("dirty", [])),
      "every dirty entry carries an ABS path — the key the tree badges on")
cap2 = call("status", cwd=REPO2)
check(cap2["body"].get("repo") is True and cap2["body"].get("truncated") is True and cap2["body"].get("error"),
      "a repo over the status cap refuses rather than dumping", repr(cap2["body"])[:150])
check(os.path.exists(os.path.join(REPO, "untracked.txt")), "an untracked file survives /fs/status")
after = subprocess.run(["git", "-C", REPO, "status", "--porcelain=v1"], capture_output=True, env=GIT_ENV).stdout.decode()
check("untracked.txt" in after and "a.txt" in after, "the worktree still has the same dirt after the call", after.replace("\n", "|")[:110])
check(subprocess.run(["git", "-C", REPO, "stash", "list"], capture_output=True, env=GIT_ENV).stdout.strip() == b"",
      "and NO stash entry was created")
check(call("status", cwd=OUT)["status"] == 403, "status above the ceiling is 403")
dd = call("diff", cwd=REPO, path="a.txt")
check("-l2" in dd["body"].get("patch", "") and "+CHANGED" in dd["body"].get("patch", ""),
      "diff comes from HEAD, so a STAGED edit still shows", repr(dd["body"])[:120])
check("+untracked" in call("diff", cwd=REPO, path="untracked.txt")["body"].get("patch", ""),
      "an untracked file diffs as all-adds")
check("-b-line" in call("diff", cwd=REPO, path="sub/b.txt")["body"].get("patch", ""),
      "a deleted file diffs against HEAD (all-removes)")
check(call("diff", cwd=BOX, path="keep.txt")["status"] >= 400, "a diff with no repo is 4xx")
esc = call("diff", cwd=REPO, path="../../%s/secret.txt" % os.path.basename(OUT))
check(esc["status"] == 403, "the diff route obeys the ceiling too", str(err(esc))[:110])

# ---- a repo whose top sits ABOVE the ceiling (--cwd one level inside a repo)-
mod2 = load("sub", SUB, status_cap=6)
R2 = mod2.FS_ROUTES


def call2(route, **kw):
    try:
        return {"status": 200, "body": R2[route](qsm(**kw))}
    except mod2.FsError as e:
        return {"status": e.status, "body": {"error": str(e)}}


s2 = call2("status", cwd=SUB)
paths = [d["path"] for d in s2["body"].get("dirty", [])]
check(s2["body"].get("repo") is True and s2["body"].get("toplevel") == REPO,
      "a subdir of a repo still reports the repo", repr(s2["body"].get("toplevel")))
check("sub/b.txt" in paths, "the file inside the ceiling IS badged", ",".join(paths))
check("a.txt" not in paths and "untracked.txt" not in paths,
      "files above the ceiling are NOT named (the leak this guards)", ",".join(paths))
check(s2["body"].get("scoped") is True and s2["body"].get("omitted", 0) >= 4,
      "and the answer admits it is partial", repr({"scoped": s2["body"].get("scoped"), "omitted": s2["body"].get("omitted")}))
check(all(d["abs"].startswith(SUB) for d in s2["body"].get("dirty", [])), "no dirty entry resolves above the ceiling")
d2 = call2("diff", cwd=SUB, path="b.txt")
check("-b-line" in d2["body"].get("patch", ""), "diff still works from a subdir (paths resolve against the top)", repr(d2["body"])[:130])
check(call2("file", cwd=SUB, path="../a.txt")["status"] == 403, "and the ceiling still holds for reads from that root")

print("\n" + (f"FAILED {fails}" if fails else "ALL CHECKS PASSED"))
sys.exit(1 if fails else 0)
