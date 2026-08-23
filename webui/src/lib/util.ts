export function relTime(ts?: number): string {
  if (!ts) return ''
  const ms = ts < 1e12 ? ts * 1000 : ts
  const d = Date.now() - ms
  const min = Math.floor(d / 60000)
  if (min < 1) return 'now'
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h`
  const days = Math.floor(h / 24)
  if (days < 30) return `${days}d`
  return new Date(ms).toLocaleDateString()
}
