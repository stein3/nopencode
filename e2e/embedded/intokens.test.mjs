// Browser-free unit check for the INPUT (prompt) side of token accounting.
//
// Imports the REAL module — webui/src/lib/intokens.ts — through Node's type
// stripping (no build, no chromium):
//
//   node e2e/embedded/intokens.test.mjs
//
// What it pins down:
//   * promptTally splits the engine's token object into what the provider had
//     to PROCESS this step (input + cache.write) vs what it re-READ from the
//     prompt cache (cache.read) — both key shapes (nested cache.read/write from
//     the engine + pi-web projection, flat cacheRead/cacheWrite as pi stores it);
//   * an all-zero token object reads as "no data" (undefined), not 0;
//   * estTokens is a calibrated chars→token estimate, NOT chars/4: measured
//     2026-10-29 over 2,641 consecutive step pairs in real pi session JSONL
//     (next step's fresh prompt input ÷ this step's tool-result chars), median
//     0.307 tok/char = divisor 3.26 (p25 3.62, p75 2.80);
//   * tips state the raw numbers, so a chip's estimate is never taken as exact.
import {
  TOK_PER_CHAR,
  estChars,
  estTokens,
  fmtTok,
  promptTally,
  promptTip,
  toolTokRollup,
  toolTokTip,
  userTokTip,
} from '../../webui/src/lib/intokens.ts'

let fails = 0
const check = (ok, name, note = '') => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${note ? ` — ${note}` : ''}`)
  if (!ok) fails++
}

// ---- promptTally: nested shape (engine / pi-web projection) ----------------
const nested = promptTally({ input: 1644, output: 487, reasoning: 0, cache: { read: 14103, write: 0 } })
check(nested?.fresh === 1644 && nested?.cached === 14103 && nested?.total === 15747,
  'nested: fresh = input, cached = cache.read', JSON.stringify(nested))

// cache.write is FRESH work: the provider pays to put those tokens into the
// cache, so it belongs with input, not with re-reads.
const cw = promptTally({ input: 100, cache: { read: 900, write: 10 } })
check(cw?.fresh === 110 && cw?.cached === 900 && cw?.total === 1010,
  'cache.write counts as fresh', JSON.stringify(cw))
check(cw?.input === 100 && cw?.write === 10,
  'input / cache-write split kept for the tip', JSON.stringify(cw))

// ---- promptTally: flat shape (pi session JSONL) ---------------------------
const flat = promptTally({ input: 100, cacheRead: 900, cacheWrite: 10 })
check(flat?.fresh === 110 && flat?.cached === 900,
  'flat cacheRead/cacheWrite keys accepted', JSON.stringify(flat))

// ---- no-data cases --------------------------------------------------------
check(promptTally({ input: 0, output: 5, cache: { read: 0, write: 0 } }) === undefined,
  'all-zero prompt object -> undefined (aborted/empty step, not "0 in")')
check(promptTally(undefined) === undefined && promptTally(null) === undefined,
  'missing tokens object -> undefined')
check(promptTally({ output: 500 }) === undefined,
  'generated-only tokens object -> undefined (no prompt side reported)')

// ---- estimator calibration ------------------------------------------------
check(Math.abs(TOK_PER_CHAR - 0.305) < 0.01, 'divisor reflects the calibration (0.305 tok/char)',
  String(TOK_PER_CHAR))
const s = (n) => 'x'.repeat(n)
check(estTokens(s(775)) === 236, '775 chars -> 236 tok', String(estTokens(s(775))))
check(estTokens(s(400)) !== 100, 'NOT chars/4 (that under-reads tool output ~20%)',
  `${estTokens(s(400))} vs 100`)
check(estTokens('') === 0 && estTokens(undefined) === 0 && estTokens(null) === 0,
  'empty/missing text -> 0')
check(estTokens(s(1000)) > estTokens(s(500)), 'monotonic in length')

// ---- formatters -----------------------------------------------------------
check(fmtTok(999) === '999', 'below 1K raw', fmtTok(999))
check(fmtTok(1644) === '1.6K', '1644 -> 1.6K', fmtTok(1644))
check(fmtTok(1000) === '1K', 'exact 1K drops the .0', fmtTok(1000))
check(fmtTok(177_700_000) === '177.7M', 'millions', fmtTok(177700000))

// ---- tips carry the raw numbers ------------------------------------------
const tip = promptTip(nested)
check(tip.includes('1,644') && tip.includes('14,103') && /new/.test(tip) && /cache/.test(tip),
  'prompt tip spells both parts out', tip)
check(promptTip(undefined) === '', 'promptTip(undefined) = ""', String(promptTip(undefined)))
const tt = toolTokTip(estTokens(s(775)), 775)
check(tt.includes('236') && tt.includes('775') && /est/.test(tt), 'tool tip = est + raw chars + rule', tt)
const ut = userTokTip(200)
check(ut.includes('200') && ut.includes('61') && /est/.test(ut), 'user tip = est + raw chars', ut)
check(estChars(775) === estTokens('z'.repeat(775)), 'estChars matches estTokens for the same length')
check(estChars(0) === 0 && estChars(-5) === 0 && estChars(NaN) === 0, 'estChars guards junk')

// ---- per-tool rollup: which tools dump the most into the prompt ----------
const rr = toolTokRollup([
  { tool: 'bash', out: 'x'.repeat(400) },
  { tool: 'bash', out: 'y'.repeat(200) },
  { tool: 'lookup', out: 'z'.repeat(775) },
  { tool: 'edit', out: '' },
])
check(rr[0]?.tool === 'lookup' && rr[0]?.tokens === estTokens('z'.repeat(775)),
  'sorted by tokens desc', JSON.stringify(rr))
const bash = rr.find((r) => r.tool === 'bash')
check(bash?.calls === 2 && bash?.tokens === estTokens('x'.repeat(400)) + estTokens('y'.repeat(200)),
  'per-tool sum across calls', JSON.stringify(bash))
check(!rr.some((r) => r.tool === 'edit'), 'empty output contributes no row')
check(toolTokRollup([]).length === 0, 'no parts -> no rows')

console.log(fails ? `\nFAILURES: ${fails}` : '\nall intokens assertions passed')
process.exit(fails ? 1 : 0)
