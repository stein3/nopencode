// Client-side attachment staging for the composer: read picked/dropped/pasted
// Files into data URLs, enforce per-file/per-message size limits, and derive
// display labels. No further prep is needed engine-side — prompt_async accepts
// {type:'file', mime, url:'data:<mime>;base64,…', filename} parts verbatim
// (text/code files are auto-inlined for the model, images pass through).

export interface Attachment {
  id: string
  filename: string
  mime: string
  size: number
  dataUrl: string // data:<mime>;base64,<b64> — sent as-is as the part url
}

export const MAX_FILE_BYTES = 10 * 1024 * 1024
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024

export function newAttId(): string {
  return 'att-' + Math.random().toString(36).slice(2, 10)
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) {
    const kb = n / 1024
    return `${kb >= 100 ? Math.round(kb) : Math.round(kb * 10) / 10} KB`
  }
  return `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`
}

// Extension-derived badge label: probe.ts → TS, app.worker.tsx → TSX,
// Makefile (no extension) → FILE. Capped so odd names stay chip-sized.
export function extLabel(filename?: string): string {
  const name = filename ?? ''
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1) : ''
  const clean = ext.replace(/[^a-z0-9]/gi, '').toUpperCase()
  return clean ? clean.slice(0, 5) : 'FILE'
}

export function isImageMime(mime?: string): boolean {
  return !!mime && mime.startsWith('image/')
}

// Middle ellipsis keeps both ends of long names visible: "super-long-prefix…name.ts"
export function midTrunc(s: string, max = 26): string {
  if (s.length <= max) return s
  const head = Math.ceil((max - 1) / 2)
  const tail = max - 1 - head
  return s.slice(0, head) + '…' + s.slice(s.length - tail)
}

// Some desktop pickers hand back an empty File.type — fall back to the
// extension before giving up and calling it octet-stream.
function guessMime(file: File): string {
  if (file.type) return file.type
  const dot = file.name.lastIndexOf('.')
  const ext = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : ''
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
    csv: 'text/csv',
  }
  return map[ext] ?? 'application/octet-stream'
}

export function readAttachment(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () =>
      resolve({
        id: newAttId(),
        filename: file.name || 'file',
        mime: guessMime(file),
        size: file.size,
        dataUrl: String(r.result ?? ''),
      })
    r.onerror = () => reject(r.error ?? new Error('read failed'))
    r.readAsDataURL(file)
  })
}
