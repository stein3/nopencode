import { marked } from 'marked'
import DOMPurify from 'dompurify'

// --- Security hardening -----------------------------------------------------
// All model/user HTML rendered via {@html} flows through md() -> this
// sanitizer. Strict allowlist + forbidden style/script/event handlers is the
// primary XSS *and* CSS-injection defense. The app's own styles are external
// CSS files; untrusted content is never allowed to carry <style> or style=.
DOMPurify.addHook('afterSanitizeAttributes', (node: Element) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
  // <button> is allowed ONLY to carry the app's own fence-copy button
  // (fence() below). Model-authored buttons are dropped so untrusted content
  // can't inject interactive UI.
  if (node.tagName === 'BUTTON' && node.getAttribute('class') !== 'code-copy') node.remove()
})

// Block javascript:/data:/vbscript: and any other dangerous URI schemes in
// href/src. Only a known-safe allowlist of schemes is permitted.
const PURIFY_URI_REGEXP =
  /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i

const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'hr',
    'strong', 'em', 'b', 'i', 'u', 'ins', 'mark',
    'ul', 'ol', 'li',
    'blockquote', 'pre', 'code', 'button',
    'a',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'img',
    'div', 'span', 'details', 'summary',
  ],
  ALLOWED_ATTR: [
    'href', 'title', 'alt', 'src', 'width', 'height',
    'colspan', 'rowspan', 'align', 'valign',
    'open', 'type',
    'class',
  ],
  ALLOWED_URI_REGEXP: PURIFY_URI_REGEXP,
  // CSS-injection surface: never let untrusted content become CSS.
  // FORBID_TAGS overrides ALLOWED_TAGS, so 'button' must NOT be listed here —
  // it is allowlisted for the fence copy button and filtered in the hook above.
  FORBID_TAGS: [
    'style', 'script', 'iframe', 'object', 'embed', 'applet',
    'form', 'input', 'textarea', 'select',
    'meta', 'link', 'base', 'svg', 'foreignObject', 'math',
  ],
  FORBID_ATTR: ['style'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
}

// Trusted Types: DOMPurify's RETURN_TRUSTED_TYPE returns a TrustedHTML object
// when the browser supports Trusted Types (Chrome/Edge). The CSP
// `require-trusted-types-for 'script'` then enforces that every innerHTML sink
// (Svelte's {@html}) only receives TrustedHTML. On browsers without TT support
// the config option is a no-op and returns a plain string.
const PURIFY_CONFIG_WITH_TT = {
  ...PURIFY_CONFIG,
  RETURN_TRUSTED_TYPE: true,
}
// lib/common = ~35 popular languages; keeps the bundle small vs full hljs
import hljs from 'highlight.js/lib/common'

// Element-content-only escaping for the oversized-fence fallback (quotes are
// legal raw inside text nodes)
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Cost bounds while STREAMING (md(src, true)): highlightAuto runs language
// detection over ALL bundled languages, and streaming re-parses a growing
// fence on every delta — an unlabeled multi-KB blob makes that quadratic
// fast. Above these sizes emit escaped plaintext instead (linear + bounded).
// Labeled fences get a much higher cap since single-language highlighting is
// far cheaper.
const AUTO_SKIP_AT = 4000
const HIGHLIGHT_CAP_AT = 50000
// Final renders (streaming done / history loads) tolerate much bigger fences:
// one full-cost parse per completed part is acceptable, so real highlightAuto
// colors survive. Only truly pathological blobs fall back to plaintext.
const FINAL_HIGHLIGHT_CAP_AT = 100_000

// Mode flag for the current marked.parse call: set by md() right before
// parsing, read by renderer.code. Safe because parse is synchronous — nothing
// can interleave on the single thread.
let liveParse = false

// Every fence gets a copy button. The button sits in a wrapper div, NOT inside
// the <pre>: the pre is the horizontally-scrolling box, and keeping the button
// outside it means the affordance never scrolls away. The text is read back off
// the sibling <code> element (textContent of hljs-marked-up code == source),
// so nothing extra has to survive the sanitizer.
const COPY_BTN = '<button class="code-copy" type="button" title="Copy code">📋</button>'
function fence(inner: string): string {
  return `<div class="codeblock">${COPY_BTN}<pre>${inner}</pre></div>`
}

const renderer = new marked.Renderer()
renderer.code = ((arg: unknown, maybeLang?: string) => {
  // marked >=13 passes an object; older versions pass positional args
  const text = typeof arg === 'object' && arg !== null ? (arg as { text: string }).text : (arg as string)
  const lang = typeof arg === 'object' && arg !== null ? (arg as { lang?: string }).lang : maybeLang
  const known = !!(lang && hljs.getLanguage(lang))
  // streaming caps keep per-delta re-parses bounded; final renders get the
  // generous cap so completed parts show real colors
  const cap = liveParse ? (known ? HIGHLIGHT_CAP_AT : AUTO_SKIP_AT) : FINAL_HIGHLIGHT_CAP_AT
  if (text.length > cap) {
    return fence(`<code class="hljs language-plaintext">${escapeHtml(text)}</code>`)
  }
  const l = known ? (lang as string) : 'plaintext'
  const body = lang ? hljs.highlight(text, { language: l }).value : hljs.highlightAuto(text).value
  return fence(`<code class="hljs language-${l}">${body}</code>`)
}) as typeof renderer.code

marked.use({ renderer, breaks: true, gfm: true })

export function md(src: string, live = false): string {
  liveParse = live
  try {
    return DOMPurify.sanitize(marked.parse(src, { async: false }) as string, PURIFY_CONFIG_WITH_TT)
  } finally {
    liveParse = false
  }
}
