#!/usr/bin/env python3
import sys


def main() -> None:
    src, dst = sys.argv[1], sys.argv[2]
    html = open(src, encoding="utf-8").read()
    if "ttyd-osc52-injected" in html:
        print(f"osc52 handler already present, copying {src} to {dst}", file=sys.stderr)
        open(dst, "w", encoding="utf-8").write(html)
        return
    script = """<script>
/* ttyd-osc52-injected */
(function () {
  function decode(b64) {
    var bin = atob(b64.replace(/[^A-Za-z0-9+/=]/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }
  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) {}
  }
  function writeClip(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () { legacyCopy(text); });
    } else {
      legacyCopy(text);
    }
  }
  function install(term) {
    try {
      term.parser.registerOscHandler(52, function (data) {
        if (typeof data !== 'string') return true;
        var i = data.indexOf(';');
        if (i < 0) return true;
        var payload = data.slice(i + 1);
        if (!payload || payload === '?') return true;
        writeClip(decode(payload));
        return true;
      });
    } catch (e) {}
  }
  function check() {
    if (window.term && window.term.parser) { install(window.term); return true; }
    return false;
  }
  if (!check()) setInterval(check, 200);
})();
</script>
"""
    patched = html.replace("</body>", script + "</body>", 1)
    open(dst, "w", encoding="utf-8").write(patched)
    print(f"patched {src} -> {dst} ({len(patched)} bytes)", file=sys.stderr)


if __name__ == "__main__":
    main()
