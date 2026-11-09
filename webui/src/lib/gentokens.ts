/**
 * Session-level token totals: the GENERATED half (`output + reasoning`, what the
 * model produced) and the FRESH INPUT half (`input + cache.write`, what the
 * provider had to process). Both summed over EVERY assistant message, plus every
 * descendant (subagent) session's own total.
 *
 * Neither half is the context estimate (`tokenTally` in stores.ts, which
 * includes cache.read of the newest assistant message). Measured on a real
 * engine DB: the context/raw view is 95.6-99.5% cache reads (top session 177.7M
 * cache.read vs 3.7M input + 0.18M output), so a raw sum mostly counts the same
 * context re-sent once per turn — it scales with turn count, not with work done.
 * That is why `sessTok` sums the two halves WITHOUT cache.read, and why the
 * sidebar tooltip says so. Session-level `tokens_output/tokens_reasoning/
 * tokens_input` are exact cumulative sums of that session's assistant messages,
 * and they are SELF-ONLY: subagent sessions are separate rows, never rolled up
 * into the parent, which is why this file sums the subtree explicitly.
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

/**
 * Prompt half of an engine token object. `inTally` is the INPUT-side counterpart
 * of `genTally` and returns the same thing as `promptTally(...).fresh` in
 * intokens.ts — uncached `input` + `cache.write`, cache RE-READS excluded.
 * Re-implemented here (rather than imported) so this file stays import-free for
 * Node type-stripping tests; intokens.ts owns the explanation of the split.
 */
export interface InTallySrc {
  input?: number
  promptTokens?: number
  cache?: { write?: number }
  cacheWrite?: number
}

/** Anything the sidebar knows about a session row (snapshot + live overlay). */
export interface GenSession {
  id: string
  // engine session parent (subagent sessions point at their parent)
  parent?: string
  // server snapshot: generated tokens of this session alone (snake_case because
  // both history backends project it straight from their store)
  tokens_generated?: number
  // server snapshot: fresh prompt tokens (input + cache.write) of this session
  // alone — same scope and same exclusions as `tokens_generated`
  tokens_input?: number
}

/** Live per-session metrics maintained from SSE / message fetches. */
export interface GenMetrics {
  generated?: number
  /** sum of fresh prompt tokens over the session's assistant messages */
  prompt?: number
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
 * Fresh prompt tokens of one engine token object — what the provider had to
 * PROCESS for that step. `cache.read` is NOT here on purpose: it is the same
 * context re-sent every turn, so summing it makes a session's total scale with
 * turn count rather than work done. Accepts the nested `cache.write` the engine
 * and pi-web emit and the flat `cacheWrite` pi stores in its session JSONL.
 */
export function inTally(t?: InTallySrc | null): number | undefined {
  if (!t) return undefined
  const n = (t.input ?? t.promptTokens ?? 0) + (t.cache?.write ?? t.cacheWrite ?? 0)
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

/** Same freshness rule for the input half: live overlay wins over the snapshot. */
export function inOwn(s: GenSession, metrics: Record<string, GenMetrics> = {}): number | undefined {
  return metrics[s.id]?.prompt ?? s.tokens_input
}

/**
 * Sum a per-session figure over ALL descendants (children, grandchildren,
 * …), each session counted exactly once. Built from the same full session list
 * the sidebar already has, so it costs no extra requests.
 *
 * The previous one-hop rollup under-counted any subagent that spawned its own
 * subagent; this walks the whole subtree. `seen` is also a cycle guard — a
 * parent link cycle in the store would otherwise spin forever here, and the
 * sidebar renders this on every metrics tick.
 *
 * `own` picks which half to sum (`genOwn` for generated, `inOwn` for fresh
 * prompt); both halves need the subtree walk because engine session totals are
 * SELF-ONLY — a subagent's tokens never fold into its parent.
 */
export function rollupBy(
  rows: GenSession[],
  metrics: Record<string, GenMetrics> = {},
  own: (s: GenSession, m: Record<string, GenMetrics>) => number | undefined = genOwn,
): Record<string, number> {
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
      sum += own(d, metrics) ?? 0
      const k = kids.get(d.id)
      if (k) stack.push(...k)
    }
    if (sum > 0) out[r.id] = sum
  }
  return out
}

/** Descendant sum of generated tokens (see rollupBy). */
export function genRollup(rows: GenSession[], metrics: Record<string, GenMetrics> = {}) {
  return rollupBy(rows, metrics, genOwn)
}

/** Descendant sum of fresh prompt tokens. */
export function inRollup(rows: GenSession[], metrics: Record<string, GenMetrics> = {}) {
  return rollupBy(rows, metrics, inOwn)
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

/** Row value for the input half: own + descendants. */
export function inTotal(
  s: GenSession,
  metrics: Record<string, GenMetrics>,
  roll: Record<string, number>,
): number | undefined {
  const own = inOwn(s, metrics)
  const rollup = roll[s.id]
  if (rollup) return (own ?? 0) + rollup
  return own
}

/**
 * What a sidebar row shows: the session's token total, IN + OUT, subtree
 * included. `undefined` when the session reported no usage at all (never 0 —
 * an aborted or provider-silent session must read as "no data", the same rule
 * `genTally` follows).
 */
export function sessTok(
  s: GenSession,
  metrics: Record<string, GenMetrics>,
  rollGen: Record<string, number>,
  rollIn: Record<string, number>,
): { in: number; out: number; total: number } | undefined {
  const inn = inTotal(s, metrics, rollIn) ?? 0
  const out = genTotal(s, metrics, rollGen) ?? 0
  return inn + out > 0 ? { in: inn, out, total: inn + out } : undefined
}
