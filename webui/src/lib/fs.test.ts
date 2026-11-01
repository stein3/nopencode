import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shortPath } from './fs.ts'

// The drawer header shows the directory pi actually runs the session in. It has
// to fit one line at 10.5px beside two tabs, so the HEAD of the path is what
// gets dropped — /srv/deploy/work/… tells you nothing, the workspace name does.
test('shortPath keeps the tail and elides the front', () => {
  assert.equal(shortPath('/workspace/pi-web'), '/workspace/pi-web')
  assert.equal(shortPath(''), '')
  assert.equal(shortPath('/a'.repeat(30), 8), '…/a/a/a')
  const deep = shortPath('/srv/deploy/work/team-project/subsystem-internal/src/lib', 30)
  assert.ok(deep.startsWith('…/'), deep)
  assert.ok(deep.endsWith('/src/lib'), deep)
  assert.ok(deep.length <= 30, `fits: ${deep.length}`)
})

test('shortPath never invents segments and always returns a suffix', () => {
  const p = '/one/two/three/four/five/six/seven/eight/nine/ten'
  for (const max of [10, 18, 24, 34, 60]) {
    const out = shortPath(p, max)
    const tail = out.replace(/^…\//, '/')
    assert.ok(p.endsWith(tail), `${max}: ${out} must be a suffix of ${p}`)
  }
  // one segment longer than max: fall back to the shortest form, not to empty
  assert.equal(shortPath('/averyveryverylongsegment', 12), '…/averyveryverylongsegment')
})
