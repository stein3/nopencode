import { test } from 'node:test'
import assert from 'node:assert/strict'
import { outFirstLine, outLastLine, outLineCount, previewLine, toolOutputOf, outputPlaceholder } from './outpreview.ts'

test('first line skips leading blank lines', () => {
  assert.equal(outFirstLine('\n\nhello\nworld'), 'hello')
})

test('last line skips trailing blank lines', () => {
  assert.equal(outLastLine('hello\nworld\n\n'), 'world')
  assert.equal(outLastLine(''), '')
  assert.equal(outLastLine('   \n\t'), '')
})

test('a shell row previews the BOTTOM of its output', () => {
  // the answer to `npm test` / `pytest` / `cargo build` is at the bottom; the
  // first line is a banner, a progress line, or a warning
  const out = 'npm notice run test\n\n> vitest run\n\n22 passed (22)\nDuration 1.2s'
  assert.equal(previewLine(true, out), 'Duration 1.2s')
  // a one-line command still shows that line
  assert.equal(previewLine(true, 'hi\n'), 'hi')
  // failure tails are the interesting part too
  assert.equal(previewLine(true, 'step 1 ok\nstep 2 ok\nError: boom at line 9'), 'Error: boom at line 9')
})

test('every other tool keeps the header-first convention', () => {
  assert.equal(previewLine(false, 'src/a.ts:12: found it\nsrc/b.ts:3: and here'), 'src/a.ts:12: found it')
})

test('line count is what the collapsed row advertises', () => {
  assert.equal(outLineCount('a\nb\nc\n'), 3)
})

// --- the output box is tool-agnostic: it keys off state.output, never the name

test('output comes from state.output, else metadata.output, else empty', () => {
  assert.equal(toolOutputOf({ output: 'x' }), 'x')
  // a blank-but-present output stays blank (that is a real "printed nothing")
  assert.equal(toolOutputOf({ output: '' }), '')
  assert.equal(toolOutputOf({ metadata: { output: 'y' } }), 'y')
  // non-string / absent shapes must not render '[object Object]'
  assert.equal(toolOutputOf({ output: { a: 1 } }), '')
  assert.equal(toolOutputOf({}), '')
  assert.equal(toolOutputOf(undefined), '')
})

test('pending output is not the same thing as no output', () => {
  assert.equal(outputPlaceholder('running'), '…')
  assert.equal(outputPlaceholder('pending'), '…')
  assert.equal(outputPlaceholder('completed'), '(no output)')
  assert.equal(outputPlaceholder(undefined), '(no output)')
  // an errored tool already shows its message as a detail row
  assert.equal(outputPlaceholder('error', true), '')
})
