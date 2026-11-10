import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRelayAuthorizer } from '../src/relay-auth.mjs'

test('creates separate usable credentials without printing or overwriting them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-relay-init-'))
  const directory = join(root, 'credentials')
  const executable = fileURLToPath(new URL('../adapters/pac-init-relay-auth.mjs', import.meta.url))
  async function invoke() {
    const child = spawn(process.execPath, [executable, directory, 'testpac'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk }); child.stderr.on('data', (chunk) => { output += chunk })
    const [code] = await once(child, 'close')
    return { code, output }
  }
  try {
    const first = await invoke()
    assert.equal(first.code, 0)
    const agent = (await readFile(join(directory, 'agent.token'), 'utf8')).trim()
    const source = (await readFile(join(directory, 'source.token'), 'utf8')).trim()
    assert.match(agent, /^[a-f0-9]{64}$/); assert.match(source, /^[a-f0-9]{64}$/)
    assert.notEqual(agent, source)
    assert.doesNotMatch(first.output, new RegExp(`${agent}|${source}`))
    const authorize = createRelayAuthorizer(join(directory, 'relay-auth.json'))
    assert.equal(authorize({ name: 'testpac', role: 'register', token: agent }), true)
    assert.equal(authorize({ name: 'testpac', role: 'source', token: source }), true)
    assert.notEqual((await invoke()).code, 0)
    assert.equal((await readFile(join(directory, 'agent.token'), 'utf8')).trim(), agent)
  } finally { await rm(root, { recursive: true, force: true }) }
})
