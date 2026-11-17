import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter, once } from 'node:events'
import { PassThrough } from 'node:stream'
import { startAgent, connectSource } from '../src/acp-transport.mjs'
import { createServer } from 'node:http'
import test from 'node:test'
import { WebSocket, WebSocketServer } from 'ws'
import { createRelayAuthorizer } from '../src/relay-auth.mjs'
import { sourcePrincipal } from '../src/source-principal.mjs'
import { attachAcpRelay } from '../src/acp-relay.mjs'
const hash = value => createHash('sha256').update(value).digest('hex')

test('source identity is scoped by PAC and stable across an explicitly mapped credential rotation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-source-identity-')), file = join(root, 'auth.json')
  const authorize = createRelayAuthorizer(file)
  try {
    const old = hash('synthetic-old'), next = hash('synthetic-next')
    const entry = { sourceHashes: [old, next], agentHashes: [], sourceIds: { [old]: 'source-a', [next]: 'source-a' } }
    await writeFile(file, JSON.stringify({ pacs: { one: entry, two: entry } }))
    const context = (name, token) => authorize.context({ role: 'source', name, token })
    assert.equal(context('one', 'synthetic-old').sourcePrincipal, context('one', 'synthetic-next').sourcePrincipal)
    assert.notEqual(context('one', 'synthetic-old').sourcePrincipal, context('two', 'synthetic-old').sourcePrincipal)
    assert.equal(context('one', 'unknown'), null)
    delete entry.sourceIds[next]
    await writeFile(file, JSON.stringify({ pacs: { one: entry } }))
    assert.notEqual(context('one', 'synthetic-old').sourcePrincipal, context('one', 'synthetic-next').sourcePrincipal)
    entry.sourceIds[next] = '../invalid'
    await writeFile(file, JSON.stringify({ pacs: { one: entry } }))
    assert.equal(context('one', 'synthetic-next'), null)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('relay sends source identity only from successful authentication and ignores spoofed source headers', { timeout: 5000 }, async () => {
  const server = createServer(), relay = attachAcpRelay(server, { authorize: ({ token }) => ['synthetic-agent', 'synthetic-a', 'synthetic-b'].includes(token), openTimeoutMs: 1000 })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `ws://127.0.0.1:${server.address().port}/acp-relay/`
  const connect = (role, token) => new WebSocket(base + role, { headers: { authorization: `Bearer ${token}`, 'x-pac-name': 'test', 'x-pac-source-principal': 'f'.repeat(64) } })
  const registration = connect('register', 'synthetic-agent'), sources = []
  try {
    await once(registration, 'open')
    const identities = []
    for (const token of ['synthetic-a', 'synthetic-a', 'synthetic-b']) {
      const open = once(registration, 'message')
      const source = connect('source', token); sources.push(source)
      source.on('error', () => {})
      await once(source, 'open')
      const value = JSON.parse((await open)[0].toString())
      assert.equal(value.type, 'open')
      assert.match(value.sourcePrincipal, /^[a-f0-9]{64}$/)
      assert.notEqual(value.sourcePrincipal, 'f'.repeat(64))
      assert.equal(JSON.stringify(value).includes(token), false)
      identities.push(value.sourcePrincipal)
      source.terminate()
    }
    assert.equal(identities[0], identities[1])
    assert.notEqual(identities[0], identities[2])
  } finally { for (const source of sources) source.terminate(); registration.terminate(); relay.close(); server.close() }
})

test('identity derivation rejects values that would be coerced to valid names', () => {
  for (const value of [undefined, null, 1, {}, ['source']]) {
    assert.throws(() => sourcePrincipal(value, hash('synthetic')))
    assert.throws(() => sourcePrincipal('pac', value))
    if (value !== undefined) assert.throws(() => sourcePrincipal('pac', hash('synthetic'), value))
  }
})


test('agent passes only the authenticated principal to its child environment', { timeout: 5000 }, async () => {
  const server = createServer(), relay = attachAcpRelay(server, { authorize: () => true })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const url = `ws://127.0.0.1:${server.address().port}`
  let captured, child, resolveSpawn
  const spawned = new Promise(resolve => { resolveSpawn = resolve })
  const environment = { PAC_SOURCE_PRINCIPAL: 'forged', pac_source_principal: 'also-forged', SYNTHETIC_MARKER: 'preserved' }
  const agent = await startAgent({ url, name: 'synthetic', token: 'synthetic-agent', command: 'never-executed', env: environment,
    spawnChild(command, args, options) {
      captured = options.env
      child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })
      resolveSpawn(); return child
    }, stopChild() { child.emit('close', 0) } })
  let source
  try {
    source = await connectSource({ url, name: 'synthetic', token: 'synthetic-source' })
    source.on('error', () => {})
    await spawned
    assert.equal(captured.PAC_SOURCE_PRINCIPAL, sourcePrincipal('synthetic', hash('synthetic-source')))
    assert.equal(captured.pac_source_principal, undefined)
    assert.equal(captured.SYNTHETIC_MARKER, 'preserved')
    assert.equal(environment.PAC_SOURCE_PRINCIPAL, 'forged', 'do not mutate the caller environment')
  } finally { source?.destroy(); await agent.close(); relay.close(); server.close() }
})


test('agent refuses an old relay open message without authenticated source identity', { timeout: 5000 }, async () => {
  const server = createServer(), sockets = new WebSocketServer({ server })
  sockets.on('connection', socket => socket.send(JSON.stringify({ type: 'open', channel: 'synthetic-channel' })))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  let spawned = 0, resolveError
  const error = new Promise(resolve => { resolveError = resolve })
  const agent = await startAgent({ url: `ws://127.0.0.1:${server.address().port}`, name: 'synthetic', token: 'synthetic', command: 'never-executed',
    spawnChild() { spawned++; throw new Error('must not execute') }, onError: resolveError })
  try {
    assert.match((await error).message, /authenticated source identity/)
    assert.equal(spawned, 0)
  } finally { await agent.close(); for (const socket of sockets.clients) socket.terminate(); sockets.close(); server.close() }
})
