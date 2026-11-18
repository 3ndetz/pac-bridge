import assert from 'node:assert/strict'
import { copyFile, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import test from 'node:test'
import { createSearch, resolveSearchExecutable } from '../src/acp-search.mjs'

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


test('runner search uses the OpenCode cache when PATH has no ripgrep', { skip: !process.env.PAC_TEST_RG }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-search-cache-'))
  try {
    const cache = join(root, 'cache with spaces'), bin = join(cache, 'opencode', 'bin')
    await mkdir(bin, { recursive: true })
    const binary = join(bin, process.platform === 'win32' ? 'rg.exe' : 'rg')
    await copyFile(process.env.PAC_TEST_RG, binary)
    await writeFile(join(root, 'fixture.txt'), 'cache-only-needle\n')
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const moduleUrl = new URL('../src/acp-search.mjs', import.meta.url).href
    const script = `import {createSearch} from ${JSON.stringify(moduleUrl)}; const s=await createSearch({root:process.argv[1],sessionId:'fixture'}); console.log(JSON.stringify({glob:await s.glob({sessionId:'fixture',pattern:'fixture.txt'}),grep:await s.grep({sessionId:'fixture',path:'fixture.txt',pattern:'cache-only-needle',outputMode:'content'})}))`
    const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, root], {
      env: { ...process.env, PATH: '', Path: '', XDG_CACHE_HOME: cache }, timeout: 30000,
    })
    const observed = JSON.parse(result.stdout)
    assert.match(observed.glob.output, /fixture\.txt/)
    assert.match(observed.grep.output, /1:cache-only-needle/)
    assert.equal(await resolveSearchExecutable({ executable: 'explicit-rg', env: { XDG_CACHE_HOME: cache } }), 'explicit-rg')
    assert.equal(await resolveSearchExecutable({ env: {}, home: root }), 'rg')
    await assert.rejects(resolveSearchExecutable({ env: { XDG_CACHE_HOME: 'relative' } }), /absolute/)
    await assert.rejects(resolveSearchExecutable({ executable: '' }), /Invalid search executable/)
  } finally {
    // This exact fresh temporary directory belongs only to this fixture.
    const base = await realpath(tmpdir()), actual = await realpath(root), local = relative(base, actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-search-cache-')) await rm(actual, { recursive: true, force: true })
  }
})
