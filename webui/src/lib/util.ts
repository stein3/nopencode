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

// user aborts (MessageAbortedError) render muted, never as red error tiles —
// same exclusion the TUI applies
export function isAborted(e: any): boolean {
  return e?.name === 'MessageAbortedError'
}

// Titlecase per dash/space segment ('build' → 'Build', 'my-agent' → 'My-Agent').
// Shared by roleLabel and AgentPicker so agent display names never drift.
export function titleName(s: string): string {
  return s.replace(
    /(^|[\s-])(\w)/g,
    (_s: string, sep: string, ch: string) => sep + ch.toUpperCase(),
  )
}

// Engine-injected subagent task results arrive as USER-role messages whose
// text part is `synthetic:true` and shaped:
//   <task id="ses_…" state="completed|error">
//   <summary>Background task completed|failed: DESCRIPTION</summary>
//   <task_result>…reply…</task_result>   (errors use <task_error>)
// The text prefix is unique and survives every data path (live REST, SSE
// upsert, chatserver history projection — which doesn't emit `synthetic`),
// so the prefix alone is the discriminator. Returns undefined for real
// user messages.
const TASK_NOTICE_RE = /^<task id="(ses_[^"]+)" state="(completed|error)">/

export interface TaskNotice {
  id: string
  state: 'completed' | 'error'
  desc: string
}

export function taskNoticeOf(m: any): TaskNotice | undefined {
  if (m?.role !== 'user') return undefined
  for (const p of m.parts ?? []) {
    if (p.type !== 'text') continue
    const hit = TASK_NOTICE_RE.exec(p.text ?? '')
    if (!hit) continue
    // description from the <summary> line; engine wording varies only in
    // completed|failed — strip either prefix
    const desc = /<summary>Background task (?:completed|failed):\s*(.*?)<\/summary>\s*\n/.exec(
      p.text ?? '',
    )?.[1]
    return { id: hit[1], state: hit[2] as TaskNotice['state'], desc: (desc ?? '').trim() }
  }
  return undefined
}

// head/export label for one message: user rows are "you", errored turns
// present as "Error", everything else shows the engine-stamped agent name
// titlecased; missing agent falls back to the product name. Shared by
// Transcript headers and the commands.ts export/copy/timeline builders.
export function roleLabel(m: any): string {
  if (taskNoticeOf(m)) return 'subagent'
  if (m.role === 'user') return 'you'
  if (m.error && !isAborted(m.error)) return 'Error'
  return titleName(m.agent || 'nopencode')
}
