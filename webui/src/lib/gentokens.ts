/**
 * "Generated tokens" — what the model actually produced for a session:
 * `output + reasoning`, summed over EVERY assistant message, plus every
 * descendant (subagent) session's own generated total.
 *
 * Deliberately NOT the context estimate (`tokenTally` in stores.ts, which
 * includes input + cache.read + cache.write of the newest assistant message).
 * Measured on a real engine DB: the context/raw view is 95.6-99.5% cache reads
 * (top session 177.7M cache.read vs 3.7M input + 0.18M output), so a raw sum
 * mostly counts the same context re-sent once per turn — it scales with turn
 * count, not with work done. Session-level `tokens_output/tokens_reasoning`
 * are exact cumulative sums of that session's assistant messages, and they are
 * SELF-ONLY: subagent sessions are separate rows, never rolled up into the
 * parent, which is why this file sums the subtree explicitly.
 *
 * Kept import-free (type-only) so `node e2e/embedded/gentokens.test.mjs` can
 * import this file directly with Node's type stripping — the assertions run
 * headless, without chromium.
 */

/** An engine token object as the webui receives it on a message. */
export interface GenTallySrc {
  output?: number
  reasoning?: number
}

/** Anything the sidebar knows about a session row (snapshot + live overlay). */
export interface GenSession {
  id: string
  // engine session parent (subagent sessions point at their parent)
  parent?: string
  // server snapshot: generated tokens of this session alone (snake_case because
  // both history backends project it straight from their store)
  tokens_generated?: number
}

/** Live per-session metrics maintained from SSE / message fetches. */
export interface GenMetrics {
  generated?: number
}

/**
 * Sum one engine token object. `undefined` (not 0) when nothing was generated:
 * aborted, empty-step and provider-silent turns leave an ALL-ZERO tokens
 * object behind, and reading that as "0 generated" would blank the row forever.
 * Callers fall back to the server snapshot in that case.
 */
export function genTally(t?: GenTallySrc | null): number | undefined {
  if (!t) return undefined
  const n = (t.output ?? 0) + (t.reasoning ?? 0)
  return n > 0 ? n : undefined
}

/**
 * One session's own generated total: the live value (derived from a full
 * message fetch, so it is current for open tabs) wins over the history
 * snapshot, which only moves when the list is re-fetched.
 */
export function genOwn(s: GenSession, metrics: Record<string, GenMetrics> = {}): number | undefined {
  return metrics[s.id]?.generated ?? s.tokens_generated
}

/**
 * pid -> sum of generated tokens over ALL descendants (children, grandchildren,
 * …), each session counted exactly once. Built from the same full session list
 * the sidebar already has, so it costs no extra requests.
 *
 * The previous one-hop rollup under-counted any subagent that spawned its own
 * subagent; this walks the whole subtree. `seen` is also a cycle guard — a
 * parent link cycle in the store would otherwise spin forever here, and the
 * sidebar renders this on every metrics tick.
 */
export function genRollup(rows: GenSession[], metrics: Record<string, GenMetrics> = {}) {
  const ids = new Set(rows.map((r) => r.id))
  const kids = new Map<string, GenSession[]>()
  for (const r of rows) {
    if (!r.parent || !ids.has(r.parent)) continue
    const arr = kids.get(r.parent)
    if (arr) arr.push(r)
    else kids.set(r.parent, [r])
  }
  const out: Record<string, number> = {}
  for (const r of rows) {
    const stack = [...(kids.get(r.id) ?? [])]
    const seen = new Set<string>()
    let sum = 0
    for (let i = 0; i < stack.length; i++) {
      const d = stack[i]
      if (seen.has(d.id)) continue
      seen.add(d.id)
      sum += genOwn(d, metrics) ?? 0
      const k = kids.get(d.id)
      if (k) stack.push(...k)
    }
    if (sum > 0) out[r.id] = sum
  }
  return out
}

/** Row value: own + descendants (0 descendants falls back to own alone). */
export function genTotal(
  s: GenSession,
  metrics: Record<string, GenMetrics>,
  roll: Record<string, number>,
): number | undefined {
  const own = genOwn(s, metrics)
  const rollup = roll[s.id]
  if (rollup) return (own ?? 0) + rollup
  return own
}
