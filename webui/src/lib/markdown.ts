import { marked } from 'marked'
import DOMPurify from 'dompurify'
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
    return DOMPurify.sanitize(marked.parse(src, { async: false }) as string)
  } finally {
    liveParse = false
  }
}
