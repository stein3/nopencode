#!/usr/bin/env python3
import re
import sys

VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">'
VW_RE = re.compile(r'<meta[^>]*name\s*=\s*["\']viewport["\'][^>]*>', re.I)

OSC52 = """<script>
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

# On-screen key buttons for phones/tablets. Positioned at the bottom, near the
# soft keyboard (lifted above it via visualViewport). To remove a shortcut,
# delete the corresponding {label: ...} entry below (each row is rendered
# independently).
TOOLBAR = r"""<style>
#oc-kb-toggle{position:fixed;right:10px;bottom:10px;z-index:2147483000;width:52px;height:52px;border-radius:50%;border:1px solid rgba(255,255,255,.2);background:rgba(20,20,20,.85);color:#fff;font-size:22px;line-height:1;box-shadow:0 2px 8px rgba(0,0,0,.5);touch-action:manipulation}
#oc-kb-bar{position:fixed;left:0;right:0;bottom:0;z-index:2147483000;background:rgba(15,15,15,.94);border-top:1px solid rgba(255,255,255,.15);font-family:sans-serif;user-select:none;-webkit-user-select:none;touch-action:pan-y;display:none;max-height:50vh;overflow-y:auto;-webkit-overflow-scrolling:touch}
#oc-kb-bar.oc-open{display:block}
#oc-kb-bar *,#oc-kb-toggle{box-sizing:border-box}
#oc-kb-bar .oc-head{display:flex;justify-content:flex-end;padding:2px 4px 0}
#oc-kb-bar .oc-hide{border:none;background:transparent;color:#aaa;font-size:14px;padding:8px 12px;min-height:0;touch-action:manipulation}
#oc-kb-bar .oc-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(48px,1fr));gap:4px;padding:0 6px 6px}
#oc-kb-bar .oc-row.oc-fnrow{display:none}
#oc-kb-bar.oc-fn .oc-row.oc-fnrow{display:grid}
#oc-kb-bar button{min-width:0;min-height:48px;padding:8px 2px;border:none;border-radius:8px;background:rgba(255,255,255,.12);color:#eee;font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;touch-action:manipulation}
#oc-kb-bar button:active{background:rgba(255,255,255,.3)}
#oc-kb-bar button.oc-mod-on{background:#ffd54f;color:#111}
#oc-kb-bar button.oc-fnon{background:#4fc3f7;color:#111}
</style>
<script>
/* ttyd-kb-injected */
(function () {
  'use strict';
  var BAR_ID = 'oc-kb-bar', TOG_ID = 'oc-kb-toggle';
  if (document.getElementById(BAR_ID)) return;

  var mods = {ctrl: 0, shift: 0, alt: 0};
  var modBtns = {};

  /* Edit this list to add/remove buttons. Delete a line to drop a shortcut.
     spec.ctrl/shift/alt set the modifier on that key press.
     'mod' buttons are sticky: tap once to latch, then type on the phone
     keyboard; the modifier is applied to the next key. Tap again to release. */
  var ROWS = [
    {keys: [
      {label: 'Esc', key: 'Escape'},
      {label: 'Ctrl', mod: 'ctrl'},
      {label: 'Shift', mod: 'shift'},
      {label: 'Alt', mod: 'alt'},
      {label: 'Fn', fn: true}
    ]},
    {keys: [
      {label: 'Ctrl+P', key: 'p', spec: {ctrl: true}},
      {label: 'Ctrl+C', key: 'c', spec: {ctrl: true}},
      {label: 'Ctrl+D', key: 'd', spec: {ctrl: true}},
      {label: 'Ctrl+K', key: 'k', spec: {ctrl: true}},
      {label: 'Ctrl+W', key: 'w', spec: {ctrl: true}},
      {label: 'Ctrl+U', key: 'u', spec: {ctrl: true}}
    ]},
    {keys: [
      {label: '\u2191', key: 'ArrowUp'},
      {label: '\u2193', key: 'ArrowDown'},
      {label: '\u2190', key: 'ArrowLeft'},
      {label: '\u2192', key: 'ArrowRight'},
      {label: 'Ctrl+A', key: 'a', spec: {ctrl: true}},
      {label: 'Ctrl+E', key: 'e', spec: {ctrl: true}},
      {label: 'PgUp', key: 'PageUp'},
      {label: 'PgDn', key: 'PageDown'}
    ]},
    {keys: [
      {label: 'Tab', key: 'Tab'},
      {label: 'Enter', key: 'Enter'},
      {label: '\u232b', key: 'Backspace'},
      {label: 'Del', key: 'Delete'}
    ]},
    {fnrow: true, keys: (function () {
      var k = [];
      for (var i = 1; i <= 12; i++) k.push({label: 'F' + i, key: 'F' + i});
      return k;
    })()}
  ];

  var ESCMAP = {
    Escape: '\x1b', Enter: '\r', Backspace: '\x7f', Delete: '\x1b[3~',
    Tab: '\t', ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowLeft: '\x1b[D',
    ArrowRight: '\x1b[C', Home: '\x1b[H', End: '\x1b[F',
    PageUp: '\x1b[5~', PageDown: '\x1b[6~',
    F1: '\x1bOP', F2: '\x1bOQ', F3: '\x1bOR', F4: '\x1bOS',
    F5: '\x1b[15~', F6: '\x1b[17~', F7: '\x1b[18~', F8: '\x1b[19~',
    F9: '\x1b[20~', F10: '\x1b[21~', F11: '\x1b[23~', F12: '\x1b[24~'
  };

  function escStr(ev) {
    if (ev.ctrlKey && ev.key && ev.key.length === 1) {
      return String.fromCharCode(ev.key.toUpperCase().charCodeAt(0) - 64);
    }
    if (ESCMAP.hasOwnProperty(ev.key)) return ESCMAP[ev.key];
    if (ev.key && ev.key.length === 1) return ev.key;
    return '';
  }

  /* Send a keystroke to the terminal. ttyd 1.7+ uses xterm.js, where a
     physical key ends in triggerDataEvent() / _onData.fire(), which ttyd
     wires (onData -> sendData) to the WebSocket. Bytes are preferred over
     synthetic KeyboardEvents, which xterm.js largely ignores. */
  function feed(data) {
    var term = window.term;
    if (!data || !term) return;
    try {
      var cs = term._core && (term._core.coreService || term._core._coreService);
      if (cs && typeof cs.triggerDataEvent === 'function') {
        cs.triggerDataEvent(data);
        return;
      }
    } catch (e) {}
    try {
      if (term._onData && term._onData.fire) { term._onData.fire(data); return; }
    } catch (e) {}
    try {
      if (typeof term.input === 'function') { term.input(data); return; }
    } catch (e) {}
  }

  /* xterm.js sometimes fails to repaint cells changed by an app's incremental
     redraw (e.g. opencode rewriting an input line after a middle delete),
     leaving stale text on screen even though its buffer is correct. Force a
     repaint from the buffer so the DOM/canvas catches up. Refreshing only the
     rows around the cursor (the input box) keeps it cheap on a phone. */
  function repaintAround() {
    var t = window.term;
    if (!t || typeof t.refresh !== 'function') return;
    var r0 = 0, r1 = t.rows - 1;
    try {
      var y = t.buffer.active.cursorY;
      r0 = Math.max(0, y - 2);
      r1 = Math.min(t.rows - 1, y + 2);
    } catch (e) {}
    t.refresh(r0, r1);
  }

  function repaintSoon() {
    repaintAround();
    setTimeout(repaintAround, 120);
    setTimeout(repaintAround, 500);
    setTimeout(repaintAround, 1000);
  }

  /* Repaint shortly after every redraw xterm parses. onWriteParsed fires after
     the data has been applied to the buffer, so this repaint always runs after
     the redraw arrives, regardless of the network round-trip delay. */
  function installRepaintHook() {
    var t = window.term;
    if (!t || typeof t.onWriteParsed !== 'function' || t.__ocRepaintHook) return;
    t.__ocRepaintHook = true;
    var last = 0;
    t.onWriteParsed(function () {
      var now = Date.now();
      if (now - last < 100) return;
      last = now;
      setTimeout(repaintAround, 40);
    });
  }
  if (!window.term) {
    (function () {
      var n = 0;
      var iv = setInterval(function () {
        if (window.term) { installRepaintHook(); clearInterval(iv); }
        else if (++n > 25) clearInterval(iv);
      }, 200);
    })();
  } else {
    installRepaintHook();
  }

  function dispatch(ev) {
    feed(escStr(ev));
    var term = window.term;
    if (!term) return;
    try {
      if (term.keyboard && term.keyboard.onKeyEvent) term.keyboard.onKeyEvent(ev);
    } catch (e) {}
  }

  function focusTerm() {
    try { if (window.term && window.term.focus) window.term.focus(); } catch (e) {}
  }

  function paintMods() {
    for (var m in modBtns) {
      if (modBtns[m]) modBtns[m].className = mods[m] ? 'oc-mod-on' : '';
    }
  }

  function toggleMod(m) {
    mods[m] = mods[m] ? 0 : 1;
    paintMods();
    focusTerm();
    repaintSoon();
  }

  function clearMods() {
    for (var m in mods) if (mods[m]) mods[m] = 0;
    paintMods();
  }

  function sendKey(spec) {
    var ev = new KeyboardEvent('keydown', {
      key: spec.key, code: spec.code || '',
      ctrlKey: !!(spec.spec && spec.spec.ctrl),
      shiftKey: !!(spec.spec && spec.spec.shift),
      altKey: !!(spec.spec && spec.spec.alt),
      metaKey: !!(spec.spec && spec.spec.meta),
      bubbles: true, cancelable: true
    });
    try { ev.preventDefault(); } catch (e) {}
    dispatch(ev);
    clearMods();
    focusTerm();
    repaintSoon();
  }

  function makeButton(spec) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = spec.label;
    if (spec.mod) {
      modBtns[spec.mod] = b;
      b.addEventListener('click', function () { toggleMod(spec.mod); });
    } else if (spec.fn) {
      b.addEventListener('click', function () {
        var bar = document.getElementById(BAR_ID);
        var on = bar.classList.toggle('oc-fn');
        b.classList.toggle('oc-fnon', on);
        focusTerm();
      });
    } else {
      b.addEventListener('click', function () { sendKey(spec); });
    }
    return b;
  }

  /* Sticky modifiers: apply a latched Ctrl/Shift/Alt to the next key typed. */
  document.addEventListener('keydown', function (ev) {
    var any = mods.ctrl || mods.shift || mods.alt;
    if (!any) return;
    if (ev.key === 'Control' || ev.key === 'Shift' || ev.key === 'Alt' || ev.key === 'Meta') return;
    ev.preventDefault();
    ev.stopPropagation();
    var n = new KeyboardEvent('keydown', {
      key: ev.key, code: ev.code || '',
      ctrlKey: mods.ctrl || ev.ctrlKey,
      shiftKey: mods.shift || ev.shiftKey,
      altKey: mods.alt || ev.altKey,
      metaKey: ev.metaKey,
      bubbles: true, cancelable: true
    });
    try { n.preventDefault(); } catch (e) {}
    dispatch(n);
    clearMods();
    repaintSoon();
  }, true);

  var bar = document.createElement('div');
  bar.id = BAR_ID;
  var head = document.createElement('div');
  head.className = 'oc-head';
  var hide = document.createElement('button');
  hide.type = 'button';
  hide.className = 'oc-hide';
  hide.textContent = '\u25bc';
  hide.title = 'Hide keys';
  hide.addEventListener('click', toggle);
  head.appendChild(hide);
  bar.appendChild(head);
  for (var ri = 0; ri < ROWS.length; ri++) {
    var row = document.createElement('div');
    row.className = 'oc-row' + (ROWS[ri].fnrow ? ' oc-fnrow' : '');
    for (var ki = 0; ki < ROWS[ri].keys.length; ki++) {
      row.appendChild(makeButton(ROWS[ri].keys[ki]));
    }
    bar.appendChild(row);
  }
  document.body.appendChild(bar);

  var tog = document.createElement('button');
  tog.id = TOG_ID;
  tog.type = 'button';
  tog.textContent = '\u2328';
  tog.title = 'Toggle keys';
  tog.addEventListener('click', toggle);
  document.body.appendChild(tog);

  var open = false;
  function toggle() {
    open = !open;
    bar.classList.toggle('oc-open', open);
    tog.style.display = open ? 'none' : '';
    placeBar();
    if (open) focusTerm();
  }

  /* Keep the bar above the on-screen keyboard: fixed elements sit at the
     bottom of the layout viewport, which the soft keyboard covers. Track the
     visual viewport and lift the bar by the obscured amount. */
  var vv = window.visualViewport;
  function placeBar() {
    var inset = 0;
    if (vv) {
      inset = Math.max(0, window.innerHeight - (vv.offsetTop + vv.height));
    }
    bar.style.bottom = inset + 'px';
    tog.style.bottom = (inset + 10) + 'px';
  }
  if (vv) {
    vv.addEventListener('resize', placeBar);
    vv.addEventListener('scroll', placeBar);
  }
  placeBar();

  /* Keep focus in the terminal when tapping the bar. Only mousedown is
     prevented here; preventing touchstart would suppress the tap/click. */
  bar.addEventListener('mousedown', function (e) { e.preventDefault(); });
})();
</script>
"""


def main() -> None:
    src, dst = sys.argv[1], sys.argv[2]
    html = open(src, encoding="utf-8").read()
    patched = False

    if VIEWPORT not in html:
        new_html = VW_RE.sub(VIEWPORT, html, count=1)
        if new_html == html and "</head>" in html:
            new_html = html.replace("</head>", VIEWPORT + "\n</head>", 1)
        if new_html != html:
            html = new_html
            patched = True

    if "ttyd-osc52-injected" not in html:
        html = html.replace("</body>", OSC52 + "</body>", 1)
        patched = True
    if "ttyd-kb-injected" not in html:
        html = html.replace("</body>", TOOLBAR + "</body>", 1)
        patched = True

    open(dst, "w", encoding="utf-8").write(html)
    if patched:
        print(f"patched {src} -> {dst} ({len(html)} bytes)", file=sys.stderr)
    else:
        print(f"already patched, copied {src} -> {dst}", file=sys.stderr)


if __name__ == "__main__":
    main()
