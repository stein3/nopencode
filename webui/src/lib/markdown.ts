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

// Every fence gets a copy button, and a header row when there's a language to
// name. The row and the button live outside the <pre>: the pre is the
// horizontally-scrolling box, so keeping them outside means neither scrolls
// away, and the copied text stays byte-exact (read back off the sibling <code>
// — textContent of hljs-marked-up code == source). CSS puts the background on
// .codeblock so the header reads as part of the block.
//
// No label → no header row at all (an empty bar is just dead space); the
// button overlays the code's top-right on a matching background instead.
const COPY_BTN = '<button class="code-copy" type="button" title="Copy code">📋</button>'
function fence(lang: string, inner: string): string {
  const head = lang
    ? `<div class="code-head"><span class="code-lang">${escapeHtml(lang)}</span>${COPY_BTN}</div>`
    : ''
  const cls = lang ? 'codeblock' : 'codeblock nohead'
  return `<div class="${cls}">${head || COPY_BTN}<pre>${inner}</pre></div>`
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
    // no detection ran, so there's no honest label to show
    return fence('', `<code class="hljs language-plaintext">${escapeHtml(text)}</code>`)
  }
  const l = known ? (lang as string) : 'plaintext'
  if (lang) {
    const label = hljs.getLanguage(l)?.name ?? l
    const body = hljs.highlight(text, { language: l }).value
    return fence(label, `<code class="hljs language-${l}">${body}</code>`)
  }
  // unlabeled fence: highlightAuto reports what it guessed, free of extra cost.
  // It's often wrong on prose/small snippets — CSS hides the label unless the
  // block is hovered, focused within, or wide enough that the author clearly
  // meant real code.
  const auto = hljs.highlightAuto(text)
  return fence(auto.language ?? '', `<code class="hljs language-plaintext">${auto.value}</code>`)
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
