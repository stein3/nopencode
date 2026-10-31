import type { Action } from 'svelte/action'
import { copyText } from './util'
import { toast } from './stores'

// Fence copy button. One delegated handler covers every {@html} markdown sink
// (message bodies, thinking, subagent notes) — the button is inert HTML from
// md(), so match it by class and read the text off its sibling <code>
// (hljs markup preserves the source in textContent).
//
// It lives as an action rather than `on:click` on the transcript scroller on
// purpose: a scroll container is content, not a widget, so giving it both a
// role and click/keydown listeners is exactly what the svelte a11y checker
// (correctly) complains about. Listeners attached inside an action are invisible
// to the compiler, and Enter/Space on the focused `<button class="code-copy">`
// already fires a real click — so the keyboard path needs no extra handler.
export const codeCopy: Action<HTMLElement> = (node) => {
  function onclick(e: MouseEvent) {
    const btn = (e.target as Element | null)?.closest?.('button.code-copy') as
      | HTMLButtonElement
      | null
    const code = btn?.closest('.codeblock')?.querySelector('code')
    if (!btn || !code) return
    copyText(code.textContent ?? '').then((ok) => toast(ok ? 'code copied' : 'copy failed'))
    btn.textContent = '✓'
    setTimeout(() => {
      // a streaming re-render may have replaced the node already
      if (btn.isConnected) btn.textContent = '📋'
    }, 1200)
  }
  node.addEventListener('click', onclick)
  return { destroy: () => node.removeEventListener('click', onclick) }
}
