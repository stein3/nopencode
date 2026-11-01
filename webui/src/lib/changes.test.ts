import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isEditTool,
  patchTextOf,
  sessionChanges,
  touchedFiles,
  shellMutationHint,
} from './changes.ts'

// A tab-shaped object: the Changes tab is a projection of `tab.messages`, and
// `tab.messages` is already the root→leaf chain (pi-web seeds it with
// leafChain(); the engine prunes at a revert), so "which messages are in the
// list" IS the revert semantics.
const tab = (...messages: any[]) => ({ id: 's', title: 't', messages, live: true })

const editRow = (file: string, patch: string, at = 1) => ({
  id: 'm' + at,
  role: 'assistant',
  time: { created: at },
  parts: [
    {
      id: 'p' + at,
      type: 'tool',
      tool: 'edit',
      state: {
        status: 'completed',
        input: { path: file },
        metadata: { filediff: { file, patch, additions: 1, deletions: 1 } },
        time: { start: at, end: at },
      },
    },
  ],
})

test('a per-call projection keeps every edit of one file separate', () => {
  // The point of this tab is "WHICH message did what". The merged per-session
  // pane flattens these into one patch and renumbers every hunk header; here
  // they must stay three rows with their own patches, in transcript order.
  const t = tab(
    editRow('a.ts', '@@ -1 +1 @@\n-one\n+two', 1),
    editRow('a.ts', '@@ -1 +1 @@\n-two\n+three', 2),
    editRow('a.ts', '@@ -1 +1 @@\n-three\n+four', 3),
  )
  const rows = sessionChanges(t)
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.map((r) => r.file), ['a.ts', 'a.ts', 'a.ts'])
  assert.deepEqual(rows.map((r) => r.patch), [
    '@@ -1 +1 @@\n-one\n+two',
    '@@ -1 +1 @@\n-two\n+three',
    '@@ -1 +1 @@\n-three\n+four',
  ])
  assert.deepEqual(rows.map((r) => r.msgId), ['m1', 'm2', 'm3'])
  assert.equal(new Set(rows.map((r) => r.partId)).size, 3)
})

test('a revert removes the reverted edits — the chain IS the filter', () => {
  // Revert to before the first edit: the tab's messages are truncated at the
  // revert point (pi moves the leaf; the engine prunes), so the projection of
  // the remaining chain has nothing to show.
  const full = tab(editRow('a.ts', '@@ -1 +1 @@\n-one\n+two', 1), editRow('b.ts', '@@ -1 +1 @@\n-x\n+y', 2))
  assert.equal(sessionChanges(full).length, 2)
  assert.equal(sessionChanges(tab()).length, 0)
})

test('edit / write / apply_patch / multiedit are edit tools; read is not', () => {
  for (const t of ['edit', 'write', 'apply_patch', 'multiedit', 'Edit', 'apply_patch']) assert.ok(isEditTool(t), t)
  for (const t of ['read', 'bash', 'grep', 'find', 'ls', 'todowrite', 'question']) assert.ok(!isEditTool(t), t)
})

test('patchTextOf reads filediff.patch, then metadata.diff, then synthesises adds', () => {
  // mirrors Transcript.svelte patchTextOf — the diff block and this tab must
  // agree, or the row in the transcript and the row in the tab disagree
  assert.equal(
    patchTextOf({ state: { metadata: { filediff: { patch: 'P1' } } } }),
    'P1',
  )
  assert.equal(patchTextOf({ state: { metadata: { diff: 'P2' } } }), 'P2')
  assert.equal(patchTextOf({ state: { input: { content: 'a\nb\n' } } }), '+a\n+b')
  assert.equal(patchTextOf({ state: { input: { newString: 'x' } } }), '+x')
  assert.equal(patchTextOf({ state: { input: {} } }), '')
})

test('a write with no before-image is a row that ADMITS it has no diff', () => {
  // The merged pane silently drops these (`toDiffFiles` filters empty patches),
  // which reads as "nothing happened" for a file the agent really overwrote.
  const t = tab({
    id: 'mw',
    role: 'assistant',
    parts: [
      {
        id: 'pw',
        type: 'tool',
        tool: 'write',
        state: { status: 'completed', input: { filePath: '/w/over.ts' }, metadata: { exists: true } },
      },
    ],
  })
  const rows = sessionChanges(t)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, 'unknown')
  assert.equal(rows[0].patch, '')
  assert.equal(rows[0].file, '/w/over.ts')
})

test('a create diffs as all-adds and counts its lines', () => {
  const t = tab({
    id: 'mc',
    parts: [
      {
        id: 'pc',
        type: 'tool',
        tool: 'write',
        state: { status: 'completed', input: { filePath: '/w/new.ts', content: 'a\nb\nc\n' }, metadata: {} },
      },
    ],
  })
  const [r] = sessionChanges(t)
  assert.equal(r.kind, 'adds')
  assert.equal(r.patch, '+a\n+b\n+c')
  assert.equal(r.additions, 3)
  assert.equal(r.deletions, 0)
})

test('a tool that is still running is not a change', () => {
  const t = tab({
    id: 'mr',
    parts: [
      {
        id: 'pr',
        type: 'tool',
        tool: 'edit',
        state: { status: 'running', input: { path: 'a.ts' }, metadata: {} },
      },
    ],
  })
  assert.deepEqual(sessionChanges(t), [])
})

test('an errored edit is not a change either', () => {
  const t = tab({
    id: 'me',
    parts: [
      {
        id: 'pe',
        type: 'tool',
        tool: 'edit',
        state: { status: 'error', input: { path: 'a.ts' }, metadata: { filediff: { patch: 'nope' } } },
      },
    ],
  })
  assert.deepEqual(sessionChanges(t), [])
})

test('out-of-band shell writes are counted as a HINT, never as a change', () => {
  // pi's bash details NEVER carry a patch, and opencode's session_changes
  // filters to edit/write/apply_patch — so a `sed -i` fix is invisible here.
  // The honest response is a count, not a fake diff row.
  const bash = (cmd: string, id: string) => ({
    id,
    parts: [{ id: id + 'p', type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: cmd } } }],
  })
  const sed = tab(bash("sed -i 's/a/b/' web/pi-web.mjs", 'b1'))
  assert.deepEqual(sessionChanges(sed), [])
  assert.equal(shellMutationHint(sed), 1)

  const py = tab(bash('python3 - <<PY\nopen("x.py","w")\nPY', 'b2'))
  assert.equal(shellMutationHint(py), 1)

  const redirect = tab(bash('git diff HEAD > /tmp/p.patch', 'b3'))
  assert.equal(shellMutationHint(redirect), 1)

  // read-only shell must NOT nag
  for (const cmd of ['grep -rn "filediff" web', 'ls -la', 'git status --porcelain', 'cat web/pi-web.mjs | head']) {
    assert.equal(shellMutationHint(tab(bash(cmd, 'r'))), 0, cmd)
  }
})

test('touchedFiles keys on the path the tree lists', () => {
  const t = tab(editRow('web/pi-web.mjs', '@@ -1 +1 @@\n-a\n+b', 1))
  const set = touchedFiles(sessionChanges(t))
  assert.ok(set.has('web/pi-web.mjs'))
})
