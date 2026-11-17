import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
const exec = promisify(execFile)
const linux = process.platform === 'linux'
const installer = new URL('../scripts/install-posix.sh', import.meta.url)
const exists = path => access(path).then(() => true, () => false)
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'"

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pac-posix-revision-'))
  const repo = join(root, 'repo'), home = join(root, 'home'), keys = join(root, 'keys'), bin = join(root, 'bin')
  for (const dir of [repo, home, keys, bin, ...['scripts', 'adapters', 'src', 'source-package'].map(name => join(repo, name))]) await mkdir(dir)
  await writeFile(join(repo, 'scripts/install-posix.sh'), (await readFile(installer, 'utf8')).replaceAll('\r\n', '\n'))
  const marker = join(repo, 'adapters/pac-hapi-opencode.mjs')
  await writeFile(marker, 'synthetic-first-revision')
  await writeFile(join(repo, 'scripts/pac-posix-launcher.mjs'), '// synthetic launcher')
  await writeFile(join(repo, 'src/fixture.mjs'), '// synthetic source')
  await writeFile(join(repo, 'src/opencode-provider.mjs'), '// synthetic provider')
  for (const name of ['package.json', 'package-lock.json']) await writeFile(join(repo, 'source-package', name), '{}')
  for (const name of ['connection.json', 'pac-source-token.txt', 'pac-relay-ca.pem']) await writeFile(join(keys, name), 'synthetic-not-a-credential')
  const native = join(bin, 'opencode')
  await writeFile(native, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  for (const [name, body] of [['node', '#!/bin/sh\nprintf "24\\n"\n'], ['npm', '#!/bin/sh\nexit 0\n']]) await writeFile(join(bin, name), body, { mode: 0o700 })
  const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  const git = async (...args) => (await exec('git', args, { cwd: repo, env })).stdout.trim()
  await git('init', '--quiet')
  await git('add', '.')
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'first')
  const first = await git('rev-parse', 'HEAD')
  await writeFile(marker, 'synthetic-second-revision')
  await git('add', '.')
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'second')
  const second = await git('rev-parse', 'HEAD')
  await git('checkout', '--quiet', '--detach', first)
  const realGit = (await exec('sh', ['-c', 'command -v git'])).stdout.trim()
  await writeFile(join(bin, 'git'), `#!/bin/sh\nif [ "$1" = archive ] && [ "\${PAC_FIXTURE_MOVE_HEAD:-}" = 1 ]; then ${quote(realGit)} update-ref HEAD ${quote(second)}; fi\nexec ${quote(realGit)} "$@"\n`, { mode: 0o700 })
  const run = async (variables = {}, directory = repo) => {
    try { return { code: 0, ...(await exec('sh', [join(directory, 'scripts/install-posix.sh'), keys, native], { cwd: directory, env: { ...env, PATH: bin + ':' + process.env.PATH, ...variables }, timeout: 15000 })) } }
    catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr } }
  }
  return { root, repo, home, first, run, git, async close() { await rm(root, { recursive: true, force: true }) } }
}

test('POSIX staging uses the selected commit even if HEAD moves before archive', { skip: !linux, timeout: 30000 }, async () => {
  const f = await fixture()
  try {
    const result = await f.run({ PAC_FIXTURE_MOVE_HEAD: '1' })
    assert.equal(result.code, 0, result.stderr)
    const base = join(f.home, '.local/share/pac-bridge')
    assert.equal((await readFile(join(base, 'current'), 'utf8')).trim(), f.first)
    assert.equal(await readFile(join(base, 'versions', f.first, 'adapters/pac-hapi-opencode.mjs'), 'utf8'), 'synthetic-first-revision')
  } finally { await f.close() }
})

test('POSIX staging rejects dirty source before creating a profile', { skip: !linux, timeout: 30000 }, async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.repo, 'src/fixture.mjs'), '// local uncommitted changes')
    const result = await f.run()
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /source changes/)
    assert.equal(await exists(join(f.home, '.local')), false)
  } finally { await f.close() }
})

test('POSIX installer rejects a nested non-checkout before creating a profile', { skip: !linux, timeout: 30000 }, async () => {
  const f = await fixture()
  try {
    const nested = join(f.repo, 'nested')
    await mkdir(join(nested, 'scripts'), { recursive: true })
    await writeFile(join(nested, 'scripts/install-posix.sh'), await readFile(join(f.repo, 'scripts/install-posix.sh')))
    const result = await f.run({}, nested)
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /root of its own Git checkout/)
    assert.equal(await exists(join(f.home, '.local')), false)
  } finally { await f.close() }
})


test('POSIX installer rejects an incomplete committed provider before profile writes', { skip: !linux, timeout: 30000 }, async () => {
  const f = await fixture()
  try {
    await f.git('rm', '--quiet', 'source-package/package-lock.json')
    await f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'incomplete')
    const result = await f.run()
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /missing required tracked provider files/)
    assert.equal(await exists(join(f.home, '.local')), false)
  } finally { await f.close() }
})
