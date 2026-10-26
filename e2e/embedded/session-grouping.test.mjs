// session-grouping.test.mjs — browser-free unit check for the sidebar's
// "group by workspace" logic.
//
// Imports the REAL module — webui/src/lib/sessionGroups.ts — through Node's
// type stripping (no build, no chromium), so it runs anywhere:
//
//   node e2e/embedded/session-grouping.test.mjs
//
// What it pins down:
//   * grouping ON buckets rows under one group per ROOT cwd, in order of first
//     appearance (rows arrive sorted updated-desc);
//   * subagent rows inherit their root's cwd, so a nested tree is never split
//     across two headers;
//   * grouping OFF returns ONE anonymous group holding the rows in their
//     original updated-desc order — the pre-grouping flat layout, NOT the
//     bucketed order (this is the whole point of the checkbox);
//   * a backend whose sessions carry no cwd (plain opencode engine) yields one
//     anonymous group even with grouping on, so the UI renders the old flat
//     list and hides the checkbox (hasWorkspace() === false);
//   * wsLabel() degrades sanely on '', '/', and trailing slashes.
import { groupRowsByWorkspace, hasWorkspace, wsLabel } from '../../webui/src/lib/sessionGroups.ts'

let fails = 0
const check = (ok, name, note = '') => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${note ? ` — ${note}` : ''}`)
  if (!ok) fails++
}

// rows shaped like the sidebar's Disp: { s: { id, cwd }, depth }
const R = (id, cwd, depth = 0) => ({ s: { id, cwd }, depth })
const ids = (groups) => groups.map((g) => g.rows.map((r) => r.s.id))
const keys = (groups) => groups.map((g) => g.key)

// ---- grouping ON: one group per root cwd, first-appearance order ----------
// updated-desc input order: C(/ws/a) B(/ws/b) A(/ws/a)
const rows = [R('C', '/ws/a'), R('B', '/ws/b'), R('A', '/ws/a')]
const g = groupRowsByWorkspace(rows, true)
check(g.length === 2, 'two workspaces -> two groups', `got ${g.length}`)
check(JSON.stringify(keys(g)) === '["/ws/a","/ws/b"]', 'group order = first appearance', JSON.stringify(keys(g)))
check(JSON.stringify(ids(g)) === '[["C","A"],["B"]]', 'rows bucketed, order kept inside a group', JSON.stringify(ids(g)))
check(g.map((x) => x.name).join(',') === 'a,b', 'header label = last path segment', g.map((x) => x.name).join(','))

// ---- subagents inherit the root's cwd (never split across headers) --------
const tree = [
  R('root1', '/ws/a'),
  R('sub1', undefined, 1),
  R('root2', '/ws/b'),
  R('sub2', undefined, 2),
]
const gt = groupRowsByWorkspace(tree, true)
check(JSON.stringify(ids(gt)) === '[["root1","sub1"],["root2","sub2"]]', 'nested rows stay with their root', JSON.stringify(ids(gt)))
check(gt.every((x) => x.key), 'inherited group is a real cwd, not ""', JSON.stringify(keys(gt)))

// ---- grouping OFF: single flat group, ORIGINAL time order -----------------
const flat = groupRowsByWorkspace(rows, false)
check(flat.length === 1, 'off -> exactly one group', `got ${flat.length}`)
check(flat[0].key === '', 'off -> anonymous group (key "")', JSON.stringify(flat[0].key))
check(JSON.stringify(ids(flat)[0]) === '["C","B","A"]', 'off -> global updated-desc order, not bucketed', JSON.stringify(ids(flat)))
check(flat[0].rows.every((r, i) => r === rows[i]), 'off -> rows passed through by reference, unsorted')

// off must also keep nested rows inline (no re-parenting)
check(JSON.stringify(ids(groupRowsByWorkspace(tree, false))[0]) === '["root1","sub1","root2","sub2"]',
  'off -> tree order preserved inline')

// ---- no cwd anywhere (plain engine): flat even with grouping on ----------
const noWs = [R('x'), R('y'), R('z', undefined, 1)]
const gn = groupRowsByWorkspace(noWs, true)
check(gn.length === 1 && gn[0].key === '', 'no cwd -> one anonymous group, no headers', JSON.stringify(keys(gn)))
check(JSON.stringify(ids(gn)[0]) === '["x","y","z"]', 'no cwd -> rows kept in input order', JSON.stringify(ids(gn)))
check(hasWorkspace(noWs) === false, 'hasWorkspace false without any cwd (checkbox hidden)')
check(hasWorkspace(rows) === true, 'hasWorkspace true once a root carries a cwd')
check(hasWorkspace([]) === false, 'hasWorkspace false for an empty list')
check(groupRowsByWorkspace([], true).length === 0, 'empty input -> no groups')

// ---- wsLabel --------------------------------------------------------------
check(wsLabel('/a/b/') === 'b', 'wsLabel strips a trailing slash', wsLabel('/a/b/'))
check(wsLabel('') === 'other', 'wsLabel("") = other', wsLabel(''))
check(wsLabel('/') === '/', 'wsLabel("/") = /', wsLabel('/'))
check(wsLabel('/ws/a') === 'a', 'wsLabel("/ws/a") = a', wsLabel('/ws/a'))

// ---- hasWorkspace ignores depth>0 rows with no cwd -----------------------
check(hasWorkspace([R('s', undefined, 1), R('t', undefined, 2)]) === false,
  'sub-only rows with no cwd are not "workspace known"')

console.log(`\n${fails ? 'FAIL' : 'OK'} — ${fails} failed`)
process.exit(fails ? 1 : 0)
