// Image reads (read tool on a picture file): fetch bytes through the engine
// /file/content proxy and expose them as data URLs for <img> thumbnails.
// Cached by path — transcripts re-render constantly while streaming, and the
// same screenshot is often read several times across tabs.
//
// Engine response shapes (verified v1.18.18): raster images →
// {type:'binary', content:<base64>}; svg → {type:'text', content:<raw>};
// missing/unreadable files → 200 {type:'text', content:''}.

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
}

export function isImagePath(path: string): boolean {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return !!MIME[ext]
}

function load(path: string): Promise<string> {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  const mime = MIME[ext]
  if (!mime) return Promise.reject(new Error(`not an image: ${path}`))
  return fetch(`/oc/file/content?path=${encodeURIComponent(path)}`)
    .then((r) => {
      if (!r.ok) throw new Error(`${r.status}`)
      return r.json()
    })
    .then((d: { type?: string; content?: string }) => {
      const c = d.content ?? ''
      if (!c) throw new Error('no content')
      if (d.type === 'binary') return `data:${mime};base64,${c}`
      return `data:${mime};utf8,${encodeURIComponent(c)}`
    })
}

const cache = new Map<string, Promise<string>>()
const CACHE_CAP = 60

export function imageDataUrl(path: string): Promise<string> {
  let p = cache.get(path)
  if (!p) {
    p = load(path)
    // failures must not poison the cache forever (the file may exist later);
    // successes stay for the whole session
    p.catch(() => cache.delete(path))
    cache.set(path, p)
    while (cache.size > CACHE_CAP) {
      const oldest = cache.keys().next().value as string | undefined
      if (!oldest || oldest === path) break
      cache.delete(oldest)
    }
  }
  return p
}
