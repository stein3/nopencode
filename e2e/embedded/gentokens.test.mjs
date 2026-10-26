// Browser-free unit check for the sidebar's "generated tokens" math.
//
// Imports the REAL module — webui/src/lib/gentokens.ts — through Node's
// type stripping (no build, no chromium), so the assertions run anywhere:
//
//   node e2e/embedded/gentokens.test.mjs
//
// What it pins down:
//   * generated = output + reasoning only — input/cache.read/cache.write are
//     excluded, because on real engine history they are 95.6-99.5% of a
//     session's raw token volume (top session: 177.7M cache.read vs 0.18M
//     output), so a raw sum measures turn count, not work;
//   * the parent-row stat includes EVERY descendant exactly once, including
//     grandchildren (the old one-hop rollup lost those);
//   * the live per-session value overlays the server snapshot;
//   * an all-zero token object reads as "no data", not 0, so the row falls
//     back to the snapshot instead of going blank;
//   * a cyclic parent link terminates instead of spinning.
import { genTally, genOwn, genRollup, genTotal } from '../../webui/src/lib/gentokens.ts'

let fails = 0
const check = (ok, name, note = '') => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${note ? ` — ${note}` : ''}`)
  if (!ok) fails++
}

// ---- genTally --------------------------------------------------------------
check(genTally({ input: 1500, output: 800, reasoning: 200, cache: { read: 5000, write: 7 } }) === 1000,
  'output+reasoning, input/cache excluded', `${genTally({ input: 1500, output: 800, reasoning: 200, cache: { read: 5000, write: 7 } })}`)
check(genTally({ input: 12000, output: 0, reasoning: 0, cache: { read: 9000 } }) === undefined,
  'all-zero generation -> undefined (row falls back, not 0)')
check(genTally(undefined) === undefined && genTally(null) === undefined, 'missing tokens object -> undefined')
check(genTally({ output: 40 }) === 40, 'reasoning absent counts as 0')

// ---- snapshot vs live overlay ---------------------------------------------
const rows = [
  { id: 'p', tokens_generated: 1000 },
  { id: 'c1', parent: 'p', tokens_generated: 250 },
  { id: 'c2', parent: 'c1', tokens_generated: 30 }, // grandchild: sub-subagent
  { id: 'c3', parent: 'p', tokens_generated: 0 }, // provider-silent subagent
]
check(genOwn(rows[0]) === 1000, 'snapshot value used when no live metric')
check(genOwn(rows[0], { p: { generated: 1400 } }) === 1400,
  'live (full message fetch) overlays the snapshot')
check(genOwn(rows[3], { c3: { generated: 55 } }) === 55,
  'live value rescues a session whose snapshot is 0')

// ---- descendant rollup -----------------------------------------------------
const roll = genRollup(rows)
check(roll.p === 280, 'parent rollup = children + grandchildren (250+30)', `got ${roll.p}`)
check(roll.c1 === 30, 'mid-tree node rolls up its own subtree', `got ${roll.c1}`)
check(roll.c2 === undefined, 'leaf has no rollup entry')
check(genTotal(rows[0], {}, roll) === 1280, 'row stat = own + descendants', `got ${genTotal(rows[0], {}, roll)}`)
check(genTotal(rows[0], { p: { generated: 1400 } }, genRollup(rows, { p: { generated: 1400 } })) === 1680,
  'overlay + rollup compose', `${genTotal(rows[0], { p: { generated: 1400 } }, genRollup(rows, { p: { generated: 1400 } }))}`)
check(genTotal(rows[2], {}, roll) === 30, 'leaf row shows its own number')
check(genTotal({ id: 'x' }, {}, {}) === undefined, 'no data anywhere -> undefined (no "0K")')

// the live overlay must also reach hidden/collapsed subagents, which is the
// whole point of rolling up on the parent row
const mixed = [
  { id: 'p', tokens_generated: 10 },
  { id: 'a', parent: 'p', tokens_generated: 5 },
  { id: 'b', parent: 'p', tokens_generated: 7 },
]
const live = { a: { generated: 100 }, b: { generated: 20 } }
check(genTotal(mixed[0], live, genRollup(mixed, live)) === 130,
  'hidden subagents counted at their LIVE values', `${genTotal(mixed[0], live, genRollup(mixed, live))}`)

// ---- robustness ------------------------------------------------------------
const cyclic = [
  { id: 'x', parent: 'y', tokens_generated: 5 },
  { id: 'y', parent: 'x', tokens_generated: 5 },
]
let hung = false
try {
  const t0 = Date.now()
  genRollup(cyclic)
  hung = Date.now() - t0 > 1000
} catch {
  hung = false
}
check(!hung, 'cyclic parent links terminate (cycle guard)')

const orphan = [{ id: 'o', parent: 'ghost', tokens_generated: 42 }]
check(genRollup(orphan) && Object.keys(genRollup(orphan)).length === 0,
  'a parent not in the list is not fabricated (orphan stays invisible, its own row still shows)',
  JSON.stringify(genRollup(orphan)))

// ---- cross-check against the engine's own numbers -------------------------
// Real prod row (2026-10-25): the context/raw view vs the generated view of the
// same session, so the exclusion is visible as a number, not just prose.
const prodSession = { input: 3724739, output: 178679, reasoning: 134643, cache: { read: 177742336, write: 0 } }
const gen = genTally(prodSession)
const raw = prodSession.input + prodSession.output + prodSession.reasoning +
  prodSession.cache.read + prodSession.cache.write
check(gen === 313322, 'prod session generated = 178679 + 134643', `${gen}`)
check(gen / raw < 0.005, 'generated is <0.5% of the raw view it replaced', `${(100 * gen / raw).toFixed(2)}%`)

console.log(`\ngentokens: ${fails ? 'FAILED (' + fails + ')' : 'ok'}`)
process.exitCode = fails ? 1 : 0
