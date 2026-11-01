// One Monaco setup for every pane that embeds an editor.
//
// DiffPane grew this organically; the Files drawer needs the same four things
// (worker wiring, the codicon font, the two themes, extension→language) and
// copying them would give each pane its own idea of what "matches the current
// theme" means. Alias defined in vite.config.ts — monaco's exports map blocks
// deep css imports.
import * as monaco from 'monaco-editor/editor/editor.api'
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
// editor.api does NOT include the codicon stylesheet, so every glyph Monaco
// draws (fold chevrons beside unchanged regions, diff arrows, widget buttons)
// renders as nothing without this font-face declaration.
import 'monaco-codicons.css'

let ready = false

export function ensureMonaco(): void {
  if (ready) return
  ready = true
  if (!(self as any).MonacoEnvironment) {
    ;(self as any).MonacoEnvironment = { getWorker: () => new EditorWorker() }
  }
  monaco.editor.defineTheme('oc-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#1e1e1e',
      'diffEditor.insertedTextBackground': '#2ea04326',
      'diffEditor.removedTextBackground': '#f8514926',
    },
  })
  monaco.editor.defineTheme('oc-light', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#f6f8fa',
      'editor.foreground': '#1f2328',
      'editor.lineHighlightBackground': '#eaeef280',
      'editorLineNumber.foreground': '#656d76',
      'editor.selectionBackground': '#0969da33',
      'diffEditor.insertedTextBackground': '#1e725c26',
      'diffEditor.removedTextBackground': '#cf222e26',
    },
  })
}

/** The webui has 8 themes; Monaco has two bases. Anything dark-ish gets oc-dark. */
const LIGHT = new Set(['solarized-light', 'github-light', 'catppuccin-latte', 'gruvbox-light'])
export function monacoThemeFor(theme: string): string {
  return LIGHT.has(String(theme ?? '')) ? 'oc-light' : 'oc-dark'
}

const LANGS: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', md: 'markdown', json: 'json', jsonc: 'json', yaml: 'yaml', yml: 'yaml',
  sh: 'shell', bash: 'shell', zsh: 'shell', html: 'html', css: 'css', svelte: 'html', vue: 'html',
  rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp',
  toml: 'ini', ini: 'ini', sql: 'sql', rb: 'ruby', php: 'php',
  ex: 'elixir', exs: 'elixir', lua: 'lua', tf: 'hcl', graphql: 'graphql', proto: 'protobuf',
}

export function langOf(p: string): string {
  const name = String(p ?? '').toLowerCase()
  // dotfiles (`.env`, `.gitignore`, `Dockerfile.dev`) have no useful language
  const base = name.split('/').pop() ?? ''
  if (base.startsWith('.')) return 'plaintext'
  if (/^dockerfile/.test(base)) return 'dockerfile'
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : ''
  return LANGS[ext] ?? 'plaintext'
}

export { monaco }
