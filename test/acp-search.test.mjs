import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import test from 'node:test'
import { createSearch } from '../src/acp-search.mjs'

test('searches only the selected source workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-search-'))
  try {
    await mkdir(join(root, 'sub'))
    await writeFile(join(root, 'sub', 'first.txt'), 'Needle\nsecond\n')
    await writeFile(join(root, 'other.md'), 'needle\n')
    const search = await createSearch({ root, sessionId: 'session' })
    const found = await search.glob({ sessionId: 'session', pattern: '**/*.txt' })
    assert.match(found.output, /first\.txt/)
    assert.doesNotMatch(found.output, /other\.md/)
    const matches = await search.grep({ sessionId: 'session', pattern: 'needle', ignoreCase: true, outputMode: 'content', glob: '*.txt' })
    assert.match(matches.output, /first\.txt:1:Needle/)
    assert.doesNotMatch(matches.output, /other\.md/)
    assert.match((await search.grep({ sessionId: 'session', path: 'sub', pattern: 'Needle' })).output, /first\.txt/)
    assert.equal((await search.grep({ sessionId: 'session', pattern: 'no-such-result' })).output, '')
    await assert.rejects(search.grep({ sessionId: 'session', pattern: '[' }), /Search failed/)
    await assert.rejects(search.grep({ sessionId: 'session', pattern: 'x', outputMode: 'unsupported' }), /Invalid search/)
    await assert.rejects(search.glob({ sessionId: 'other', pattern: '*' }), /session/)
    await assert.rejects(search.grep({ sessionId: 'session', path: tmpdir(), pattern: 'x' }), /outside/)
    await assert.rejects(search.grep({ sessionId: 'session', path: '..', pattern: 'x' }), /outside/)
    if (process.platform !== 'win32') {
      await symlink(tmpdir(), join(root, 'outside'))
      await assert.rejects(search.glob({ sessionId: 'session', path: join(root, 'outside'), pattern: '*' }), /outside/)
    }
  } finally {
    const base = await realpath(tmpdir())
    const actual = await realpath(root)
    const local = relative(base, actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-search-')) await rm(actual, { recursive: true, force: true })
  }
})
