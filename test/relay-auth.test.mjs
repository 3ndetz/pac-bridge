import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { createRelayAuthorizer } from '../src/relay-auth.mjs'

test('authorizes each named PAC and role and reloads rotated hashes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-relay-auth-'))
  const path = join(root, 'auth.json')
  const hash = (value) => createHash('sha256').update(value).digest('hex')
  try {
    const authorize = createRelayAuthorizer(path)
    const request = (role, name, token) => authorize({ role, name, token })
    assert.equal(request('source', 'one', 'source-one'), false)
    await writeFile(path, JSON.stringify({ pacs: {
      one: { sourceHashes: [hash('source-one')], agentHashes: [hash('agent-one')] },
      two: { sourceHashes: [hash('source-two')], agentHashes: [hash('agent-two')] },
    } }))
    assert.equal(request('source', 'one', 'source-one'), true)
    assert.equal(request('register', 'one', 'agent-one'), true)
    assert.equal(request('agent', 'one', 'agent-one'), true)
    assert.equal(request('source', 'two', 'source-one'), false)
    assert.equal(request('source', 'one', 'agent-one'), false)
    assert.equal(request('register', 'one', 'source-one'), false)
    assert.equal(request('agent', '__proto__', 'agent-one'), false)
    await writeFile(path, JSON.stringify({ pacs: { one: { sourceHashes: [hash('replacement')], agentHashes: [] } } }))
    assert.equal(request('source', 'one', 'source-one'), false)
    assert.equal(request('source', 'one', 'replacement'), true)
    await writeFile(path, '{invalid')
    assert.equal(request('source', 'one', 'replacement'), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('standalone relay enforces role credentials and refuses an insecure public listener', { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-relay-server-'))
  const path = join(root, 'auth.json')
  const hash = (value) => createHash('sha256').update(value).digest('hex')
  let child, registration
  try {
    await writeFile(path, JSON.stringify({ pacs: { sample: { sourceHashes: [hash('source-secret')], agentHashes: [hash('agent-secret')] } } }))
    const adapter = fileURLToPath(new URL('../adapters/pac-relay.mjs', import.meta.url))
    const blocked = spawn(process.execPath, [adapter], { env: { ...process.env, PAC_RELAY_HOST: '0.0.0.0', PAC_RELAY_AUTH_FILE: path }, stdio: 'ignore', windowsHide: true })
    assert.notEqual((await once(blocked, 'exit'))[0], 0)
    const reservation = createServer().listen(0, '127.0.0.1')
    await once(reservation, 'listening')
    const port = reservation.address().port
    await new Promise((resolve) => reservation.close(resolve))
    child = spawn(process.execPath, [adapter], { env: { ...process.env, PAC_RELAY_HOST: '127.0.0.1', PAC_RELAY_PORT: String(port), PAC_RELAY_AUTH_FILE: path,
      PAC_RELAY_TLS_CERT: '', PAC_RELAY_TLS_KEY: '' }, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    await once(child.stdout, 'data')
    const connect = (role, token) => new WebSocket(`ws://127.0.0.1:${port}/acp-relay/${role}`, { headers: { authorization: `Bearer ${token}`, 'x-pac-name': 'sample' } })
    const invalid = connect('register', 'source-secret')
    invalid.on('error', () => {})
    const [, response] = await once(invalid, 'unexpected-response')
    assert.equal(response.statusCode, 401)
    invalid.terminate()
    registration = connect('register', 'agent-secret')
    await once(registration, 'open')
    const source = connect('source', 'source-secret')
    await once(source, 'open')
    source.terminate()
  } finally {
    registration?.terminate()
    if (child && child.exitCode === null) { child.kill(); await once(child, 'exit') }
    await rm(root, { recursive: true, force: true })
  }
})
