import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const exec = promisify(execFile)
const launcher = fileURLToPath(new URL('../scripts/pac-posix-launcher.mjs', import.meta.url))
const revision = 'a'.repeat(40)

test('POSIX launcher configures the existing runner without exposing token contents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-posix-launcher-'))
  const base = join(root, '.local', 'share', 'pac-bridge'), keys = join(root, 'private'), bin = join(base, 'bin')
  try {
    await mkdir(join(base, 'versions', revision, 'adapters'), { recursive: true })
    await mkdir(keys); await mkdir(bin)
    await Promise.all([
      writeFile(join(base, 'current'), revision), writeFile(join(base, 'connection-directory'), keys),
      writeFile(join(base, 'opencode-path'), process.execPath), writeFile(join(bin, 'opencode'), 'wrapper'),
      writeFile(join(keys, 'connection.json'), JSON.stringify({ relayUrl: 'wss://example.invalid:443', pacName: 'testpac', controllerCwd: '/controller', displayName: '#1' })),
      writeFile(join(keys, 'pac-source-token.txt'), 'PRIVATE_TOKEN_MUST_NOT_APPEAR'), writeFile(join(keys, 'pac-relay-ca.pem'), 'test-certificate'),
      writeFile(join(base, 'versions', revision, 'adapters', 'pac-hapi-opencode.mjs'),
        `process.stdout.write(JSON.stringify({args:process.argv.slice(2),name:process.env.PAC_NAME,tokenPath:process.env.PAC_SOURCE_TOKEN_FILE,sessionPath:process.env.PAC_SESSION_DIR,named:process.env.PAC_NAMED_PROVIDERS_EXPERIMENT}))`),
    ])
    const env = { ...process.env, HOME: root, USERPROFILE: root }; delete env.NODE_EXTRA_CA_CERTS
    const result = await exec(process.execPath, [launcher, 'acp'], { env })
    const value = JSON.parse(result.stdout)
    assert.deepEqual(value.args, ['acp'])
    assert.equal(value.name, 'testpac')
    assert.equal(value.tokenPath, join(keys, 'pac-source-token.txt'))
    assert.equal(value.sessionPath, join(base, 'bindings'))
    assert.equal(value.named, '1')
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_TOKEN_MUST_NOT_APPEAR/)
    await assert.rejects(exec(process.execPath, [launcher, 'acp'], { env: { ...env, NODE_EXTRA_CA_CERTS: join(root, 'other-ca') } }), /conflicts with the PAC relay CA/)
    await writeFile(join(base, 'opencode-path'), join(bin, 'opencode'))
    await assert.rejects(exec(process.execPath, [launcher, 'acp'], { env }), /Invalid PAC Bridge installation/)
  } finally {
    const actual = await realpath(root), local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-posix-launcher-')) await rm(actual, { recursive: true, force: true })
  }
})
