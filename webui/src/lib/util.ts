// Engine message info stores the model two ways depending on role: assistant
// messages carry FLAT `modelID` + `providerID`, user messages carry NESTED
// `model = { providerID, modelID }` and no flat fields. Read both so the
// role-agnostic `.model-id` badge renders on every row. Loosely typed — the
// raw engine info isn't uniformly shaped across versions.
export function msgModel(
  info?: {
    modelID?: string
    providerID?: string
    model?: { providerID?: string; modelID?: string }
  } | null,
): { providerID?: string; modelID?: string } {
  return {
    providerID: info?.providerID ?? info?.model?.providerID,
    modelID: info?.modelID ?? info?.model?.modelID,
  }
}

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
