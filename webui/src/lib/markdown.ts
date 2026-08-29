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
})

// Block javascript:/data:/vbscript: and any other dangerous URI schemes in
// href/src. Only a known-safe allowlist of schemes is permitted.
const PURIFY_URI_REGEXP =
  /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i

const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'hr',
    'strong', 'em', 'b', 'i', 'u', 's', 'del', 'ins', 'mark',
    'ul', 'ol', 'li',
    'blockquote', 'pre', 'code',
    'a',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'img',
    'div', 'span', 'details', 'summary',
  ],
  ALLOWED_ATTR: [
    'href', 'title', 'alt', 'src', 'width', 'height',
    'colspan', 'rowspan', 'align', 'valign',
    'open',
    'class',
  ],
  ALLOWED_URI_REGEXP: PURIFY_URI_REGEXP,
  // CSS-injection surface: never let untrusted content become CSS.
  FORBID_TAGS: [
    'style', 'script', 'iframe', 'object', 'embed', 'applet',
    'form', 'input', 'textarea', 'select', 'button',
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
    return `<pre><code class="hljs language-plaintext">${escapeHtml(text)}</code></pre>`
  }
  const l = known ? (lang as string) : 'plaintext'
  const body = lang ? hljs.highlight(text, { language: l }).value : hljs.highlightAuto(text).value
  return `<pre><code class="hljs language-${l}">${body}</code></pre>`
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
