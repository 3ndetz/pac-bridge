import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
const exec = promisify(execFile), windows = process.platform === 'win32'
const exporter = fileURLToPath(new URL('../windows/Export-ProviderRevision.ps1', import.meta.url))
const script = fileURLToPath(new URL('./fixtures/provider-export.ps1', import.meta.url))
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'pac-provider-revision-')), source = join(root, 'repo'), target = join(root, 'stage')
  await mkdir(source); await mkdir(target)
  const git = async (...args) => (await exec('git.exe', ['-c', 'core.hooksPath=' + join(root, 'no-hooks'), '-c', 'commit.gpgsign=false', ...args], { cwd: source, timeout: 15000 })).stdout.trim()
  try {
    await git('init', '-q'); await git('config', 'user.name', 'PAC synthetic'); await git('config', 'user.email', 'synthetic@example.invalid')
    for (const folder of ['src', 'adapters', 'source-package']) await mkdir(join(source, folder))
    await writeFile(join(source, 'src/value.mjs'), 'SELECTED_FIRST\n')
    await writeFile(join(source, 'src/\u043f\u0440\u0430\u0432\u0438\u043b\u043e.mjs'), '\u041f\u0440\u0430\u0432\u0438\u043b\u043e\n')
    await writeFile(join(source, 'adapters/install-hapi-command.mjs'), 'synthetic-wrapper\n')
    await writeFile(join(source, 'source-package/package.json'), '{"name":"selected-first"}\n')
    await writeFile(join(source, 'source-package/package-lock.json'), '{}\n')
    await git('add', '.'); await git('commit', '-qm', 'first')
    const revision = await git('rev-parse', 'HEAD')
    const stage = sha => exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Exporter', exporter, '-Source', source, '-Revision', sha, '-Destination', target], { timeout: 20000, windowsHide: true })
    const gitInput = (args, input) => new Promise((resolve, reject) => {
      const child = execFile('git.exe', ['-c', 'commit.gpgsign=false', ...args], { cwd: source, timeout: 15000 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()))
      child.stdin.end(input)
    })
    await run({ root, source, target, revision, git, gitInput, stage })
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5 }) }
}

test('Windows provider exports selected immutable commit despite moved HEAD and dirty source', { skip: !windows, timeout: 30000 }, () => fixture(async ({ source, target, revision, git, stage }) => {
  await writeFile(join(source, 'src/value.mjs'), 'SECOND\n')
  await writeFile(join(source, 'source-package/package.json'), '{"name":"second"}\n')
  await git('add', '.'); await git('commit', '-qm', 'second')
  await writeFile(join(source, 'src/value.mjs'), 'DIRTY_THIRD\n')
  await writeFile(join(source, 'source-package/package.json'), '{"name":"dirty-third"}\n')
  await stage(revision)
  assert.equal(await readFile(join(target, 'src/value.mjs'), 'utf8'), 'SELECTED_FIRST\n')
  assert.equal(await readFile(join(target, 'src/\u043f\u0440\u0430\u0432\u0438\u043b\u043e.mjs'), 'utf8'), '\u041f\u0440\u0430\u0432\u0438\u043b\u043e\n')
  assert.equal(JSON.parse(await readFile(join(target, 'source-package/package.json'), 'utf8')).name, 'selected-first')
}))

test('Windows provider export preserves a nonempty destination', { skip: !windows, timeout: 30000 }, () => fixture(async ({ target, revision, stage }) => {
  await writeFile(join(target, 'sentinel'), 'KEEP')
  await assert.rejects(stage(revision), /destination must be empty/)
  assert.equal(await readFile(join(target, 'sentinel'), 'utf8'), 'KEEP')
  assert.deepEqual(await readdir(target), ['sentinel'])
}))

test('Windows provider export rejects Git symlinks before writing files', { skip: !windows, timeout: 30000 }, () => fixture(async ({ target, git, stage }) => {
  const blob = await git('rev-parse', 'HEAD:src/value.mjs')
  await git('update-index', '--add', '--cacheinfo', '120000,' + blob + ',src/link')
  await git('commit', '-qm', 'synthetic link entry')
  await assert.rejects(stage(await git('rev-parse', 'HEAD')), /Unsupported provider Git entry/)
  assert.deepEqual(await readdir(target), [])
}))

test('Windows provider export rejects case-colliding parent paths', { skip: !windows, timeout: 30000 }, () => fixture(async ({ target, git, stage }) => {
  const blob = await git('rev-parse', 'HEAD:src/value.mjs')
  for (const path of ['src/Folder/a.mjs', 'src/folder/b.mjs']) await git('update-index', '--add', '--cacheinfo', '100644,' + blob + ',' + path)
  await git('commit', '-qm', 'synthetic case collision')
  await assert.rejects(stage(await git('rev-parse', 'HEAD')), /Ambiguous provider Git path/)
  assert.deepEqual(await readdir(target), [])
}))

test('Windows provider export rejects reserved device paths', { skip: !windows, timeout: 30000 }, () => fixture(async ({ target, git, gitInput, stage }) => {
  const blob = await git('rev-parse', 'HEAD:src/value.mjs')
  const src = await gitInput(['mktree'], `100644 blob ${blob}\tNUL.txt\n100644 blob ${blob}\tvalue.mjs\n`)
  const adapters = await git('rev-parse', 'HEAD:adapters'), packages = await git('rev-parse', 'HEAD:source-package')
  const tree = await gitInput(['mktree'], `040000 tree ${adapters}\tadapters\n040000 tree ${packages}\tsource-package\n040000 tree ${src}\tsrc\n`)
  const commit = await gitInput(['commit-tree', tree], 'synthetic reserved metadata only\n')
  await assert.rejects(stage(commit), /Unsafe provider Git path/)
  assert.deepEqual(await readdir(target), [])
}))
