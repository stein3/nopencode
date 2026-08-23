import { marked } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js'

const renderer = new marked.Renderer()
renderer.code = ((arg: unknown, maybeLang?: string) => {
  // marked >=13 passes an object; older versions pass positional args
  const text = typeof arg === 'object' && arg !== null ? (arg as { text: string }).text : (arg as string)
  const lang = typeof arg === 'object' && arg !== null ? (arg as { lang?: string }).lang : maybeLang
  const l = lang && hljs.getLanguage(lang) ? lang : 'plaintext'
  const body = lang ? hljs.highlight(text, { language: l }).value : hljs.highlightAuto(text).value
  return `<pre><code class="hljs language-${l}">${body}</code></pre>`
}) as typeof renderer.code

marked.use({ renderer, breaks: true, gfm: true })

export function md(src: string): string {
  return DOMPurify.sanitize(marked.parse(src, { async: false }) as string)
}
