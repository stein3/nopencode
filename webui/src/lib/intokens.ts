/**
 * The INPUT (prompt) side of token accounting — the counterpart of
 * `gentokens.ts`, which deliberately counts only what the model PRODUCED.
 *
 * Two different questions, two different sources:
 *
 * 1. **What did a step cost to send in?** Measured — the engine reports per-step
 *    usage on every assistant message. `promptTally` splits it into what the
 *    provider had to PROCESS (fresh) vs what it re-READ from its prompt cache.
 *
 * 2. **How much does one tool result add to the prompt?** Not reported anywhere
 *    by any engine, so it is ESTIMATED from the result text (`estTokens`). The
 *    estimate is calibrated, not guessed: measured 2026-10-29 over 2,641
 *    consecutive step pairs in 52 real pi session JSONL files — for each step,
 *    the NEXT step's fresh prompt input ÷ this step's tool-result chars —
 *    median 0.307 tokens/char (divisor 3.26; p25 3.62, p75 2.80). `chars/4`,
 *    the divisor used elsewhere in the stack, under-reads tool output (JSON,
 *    diffs and shell noise tokenize near 1 token per 3 chars) by ~20%.
 *
 * Why the measured per-step number and the estimate can't be swapped:
 *   * `input` is only the *uncached* part of the prompt. On a cache miss the
 *    same field jumps to the whole context (observed: 74,404 after a 2,327), so
 *    it is not a per-tool attribution;
 *   * summing prompt tokens across steps double-counts the context re-sent
 *    every turn (top session: 177.7M cache.read vs 3.7M fresh input — see
 *    gentokens.ts), which is why the split is shown rather than one sum.
 *
 * Kept import-free (type-only) so `node e2e/embedded/intokens.test.mjs` can
 * import this file directly with Node's type stripping — headless, no chromium.
 */

/** Calibrated tokens per character (see the header note for the measurement). */
export const TOK_PER_CHAR = 0.305

/** Minimum estimated tokens for a tool row to show its cost chip (~100 chars). */
export const TOOL_TOK_MIN = 30

/** Over this and the chip turns to warning colour — a real context dump. */
export const TOOL_TOK_BIG = 2000

/** Prompt side of one engine token object. */
export interface PromptTally {
  /** `input` — prompt tokens the provider had to read uncached */
  input: number
  /** `cache.write` — tokens billed to CREATE a prompt-cache entry */
  write: number
  /** input + write: what this step actually cost to process */
  fresh: number
  /** tokens served from its prompt cache: `cache.read` */
  cached: number
  /** fresh + cached = everything sent to the model for this step */
  total: number
}

const num = (v: any): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * Split an engine token object into fresh vs cached prompt tokens.
 *
 * Accepts both key shapes in this stack: the nested `cache.read/write` the
 * engine and the pi-web projection emit, and the flat `cacheRead/cacheWrite`
 * pi stores in its session JSONL. `cache.write` counts as FRESH — creating a
 * cache entry is billed work, re-reading one is not.
 *
 * Returns `undefined` when nothing was sent: aborted, empty-step and
 * provider-silent turns leave an ALL-ZERO tokens object behind, and rendering
 * that as "0 in" would claim a free step.
 */
export function promptTally(t?: Record<string, any> | null): PromptTally | undefined {
  if (!t) return undefined
  const input = num(t.input ?? t.promptTokens)
  const write = num(t.cache?.write ?? t.cacheWrite)
  const fresh = input + write
  const cached = num(t.cache?.read ?? t.cacheRead)
  const total = fresh + cached
  return total > 0 ? { input, write, fresh, cached, total } : undefined
}

/**
 * Estimated token size of a piece of text (a tool result, a user's message).
 * Label it as an estimate in the UI — it is a char count, not a tokenizer.
 */
export function estTokens(s?: string | null): number {
  if (!s) return 0
  return estChars(s.length)
}

/** Same estimate when the caller already has a character COUNT (a user row). */
export function estChars(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0
  return Math.round(chars * TOK_PER_CHAR)
}

/** Compact token count: 999 / 1.6K / 15.7K / 177.7M (no trailing ".0K"). */
export function fmtTok(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1e6) return trimZero((n / 1e6).toFixed(1)) + 'M'
  if (n >= 1000) return trimZero((n / 1000).toFixed(1)) + 'K'
  return String(Math.round(n))
}
const trimZero = (s: string) => (s.endsWith('.0') ? s.slice(0, -2) : s)

const n = (v: number) => Math.round(v).toLocaleString()

/** "1,644 new + 14,103 re-read …" — the measured split behind a step's chip. */
export function promptTip(t?: PromptTally | null): string {
  if (!t) return ''
  const parts = [`${n(t.input)} input${t.write ? ` + ${n(t.write)} cache-write` : ''}`,
    `${n(t.cached)} re-read from the prompt cache`]
  return (
    `${n(t.total)} prompt tokens for this step: ${parts.join(' + ')}. ` +
    `The re-read part is the conversation sent again, not new work.`
  )
}

/** Tip for a user row's own-text estimate, given its character count. */
export function userTokTip(chars: number): string {
  if (!chars) return ''
  return (
    `~${n(estChars(chars))} tokens of your text — estimated from ${n(chars)} chars ` +
    `(× ${TOK_PER_CHAR}, calibrated on real session history), not a tokenizer count. ` +
    `What this turn actually sent is on the reply's badge.`
  )
}

/**
 * Tip for a tool row's cost chip: the estimate, the raw char count it came
 * from, and the fact that every later step re-sends the result.
 */
export function toolTokTip(est: number, chars: number, truncated = false): string {
  const base =
    `~${n(est)} input tokens for this result — estimated from ${n(chars)} chars of output ` +
    `(× ${TOK_PER_CHAR}, calibrated on real session history). ` +
    `Every later step of this turn re-sends it in the prompt.`
  return truncated ? `${base} The engine truncated it, so the prompt pays this, not the original.` : base
}

/**
 * Per-tool-name rollup of estimated injected tokens over one session's
 * messages — "which tools dump the most into the prompt".
 * `out` is the tool result text as the engine reported it.
 */
export function toolTokRollup(
  parts: { tool?: string; out?: string }[],
): { tool: string; tokens: number; calls: number }[] {
  const m = new Map<string, { tool: string; tokens: number; calls: number }>()
  for (const p of parts) {
    const tok = estTokens(p.out)
    if (!tok) continue
    const key = p.tool || 'tool'
    const e = m.get(key)
    if (e) {
      e.tokens += tok
      e.calls += 1
    } else {
      m.set(key, { tool: key, tokens: tok, calls: 1 })
    }
  }
  return [...m.values()].sort((a, b) => b.tokens - a.tokens)
}
