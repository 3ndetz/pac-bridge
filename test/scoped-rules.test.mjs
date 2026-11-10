import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { matchesProjectRule, parseProjectRule, simpleBashReadPath } from '../src/scoped-rules.mjs'

test('parses scoped and unscoped project rules', () => {
  assert.deepEqual(parseProjectRule('General rule'), { content: 'General rule', paths: [] })
  assert.deepEqual(parseProjectRule('---\npaths:\n  - "src/**/*.{ts,tsx}"\n  - "/*.md"\nother: ignored\n---\nScoped'),
    { content: 'Scoped', paths: ['src/**/*.{ts,tsx}', '/*.md'] })
  assert.deepEqual(parseProjectRule('---\npaths: "src/**/*.{ts,tsx}, tests/**"\n---\nScoped').paths, ['src/**/*.{ts,tsx}', 'tests/**'])
  assert.deepEqual(parseProjectRule('---\ninvalid: [\n---\nGeneral'), { content: 'General', paths: [] })
})

test('recognizes only literal single-file shell reads for scoped rules', () => {
  assert.equal(simpleBashReadPath('cat src/file.txt'), 'src/file.txt')
  assert.equal(simpleBashReadPath('head -n 10 "src/file name.txt"'), 'src/file name.txt')
  assert.equal(simpleBashReadPath("tail --lines=2 -- 'src/file name.txt'"), 'src/file name.txt')
  for (const command of ['cat a b', 'cat $FILE', 'cat file | head', 'cat file; rm other', 'cat *.txt', 'head -n "$N" file', 'echo file', 'cat "unfinished']) {
    assert.equal(simpleBashReadPath(command), null)
  }
})

test('matches paths relative to the workspace with root and basename semantics', () => {
  const root = resolve('sample-project')
  const match = (path, patterns) => matchesProjectRule(root, join(root, path), patterns)
  assert.equal(match('src/a/file.tsx', ['src/**/*.{ts,tsx}']), true)
  assert.equal(match('src/a/file.py', ['src/**/*.{ts,tsx}']), false)
  assert.equal(match('docs/readme.md', ['*.md']), true)
  assert.equal(match('docs/readme.md', ['/*.md']), false)
  assert.equal(match('readme.md', ['/*.md']), true)
  assert.equal(matchesProjectRule(root, resolve(root, '..', 'outside.md'), ['**/*.md']), false)
  assert.equal(match('photos [2024/a', ['photos [2024/**']), false)
  assert.throws(() => parseProjectRule(`---\npaths: "${'{a,b}'.repeat(11)}.txt"\n---\nRule`), /expansion/)
})
