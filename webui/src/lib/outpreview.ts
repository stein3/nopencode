// The one line a collapsed tool row shows. Moved out of Transcript.svelte so the
// rule can be unit-tested without a browser.
export function outFirstLine(s: string): string {
  return (s.split('\n').find((l) => l.trim()) ?? '').trim()
}

export function outLastLine(s: string): string {
  const lines = s.replace(/\n+$/, '').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]
    if (l.trim()) return l.trim()
  }
  return ''
}

export function outLineCount(s: string): number {
  return s.replace(/\n+$/, '').split('\n').length
}

/**
 * The line a collapsed tool row shows.
 *
 * A shell command's ANSWER is at the bottom: for `npm test`, `pytest`,
 * `cargo build` the last line is the verdict or the error, while the first is a
 * banner, a progress line, or an npm notice. Every other tool keeps the
 * header-first convention, because for `read`/`grep`/`find` the first line IS
 * the finding. Blank tails are skipped, so a trailing newline does not blank the
 * row out.
 */
export function previewLine(shell: boolean, s: string): string {
  return shell ? outLastLine(s) : outFirstLine(s)
}
