import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import test from 'node:test'
import { WebSocketServer } from 'ws'
import { fileURLToPath } from 'node:url'
import { attachAcpRelay } from '../src/acp-relay.mjs'
import { connectSource, startAgent } from '../src/acp-transport.mjs'
import { discoverPacsDirect } from '../src/pac-direct-discovery.mjs'

test('still discovers PAC models when a workspace has unsupported OpenCode hooks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-policy-discovery-'))
  const server = createHttpServer(), relay = attachAcpRelay(server, { authorize: () => true })
  let agent
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const plugins = join(root, '.opencode', 'plugins')
    await mkdir(plugins, { recursive: true })
    await writeFile(join(plugins, 'example.js'), 'export default async () => ({})')
    const token = join(root, 'token'), url = `ws://127.0.0.1:${server.address().port}`
    await writeFile(token, 'test-token')
    agent = await startAgent({ url, name: 'testpac', token: 'test-token', command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url)), '--text-response'] })
    const result = await discoverPacsDirect({ cwd: root, env: { PAC_NAME: 'testpac', PAC_RELAY_URL: url,
      PAC_SOURCE_TOKEN_FILE: token, PAC_CONTROLLER_CWD: root } })
    assert.ok(result.models.some(item => item.id === 'PAC_testpac/sonnet'))
    assert.deepEqual(result.warnings, [])
  } finally {
    agent?.close(); relay.close(); server.close()
    const actual = await realpath(root), local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-policy-discovery-')) await rm(actual, { recursive: true, force: true })
  }
})

test('cancelled relay discovery closes an unresponsive handshake', { timeout: 5000 }, async () => {
  const server = createServer(socket => socket.resume())
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  try {
    const root = await mkdtemp(join(tmpdir(), 'pac-timeout-'))
    const file = join(root, 'token'); await writeFile(file, 'test-token')
    const url = `ws://127.0.0.1:${server.address().port}`
    const start = Date.now()
    const result = await discoverPacsDirect({ cwd: root, timeoutMs: 100, env: { PAC_NAME: 'testpac', PAC_RELAY_URL: url, PAC_SOURCE_TOKEN_FILE: file, PAC_CONTROLLER_CWD: root } })
    assert.deepEqual(result, { models: [], warnings: [{ name: 'testpac', code: 'unavailable' }] })
    assert.ok(Date.now() - start < 3000)
    const signal = AbortSignal.abort()
    await assert.rejects(connectSource({ url, name: 'testpac', token: 'test-token', signal }), /cancelled/)
  } finally { server.close() }
})

test('cancelled discovery also closes an ACP peer that never initializes', { timeout: 5000 }, async () => {
  const server = createHttpServer(), sockets = new WebSocketServer({ server })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  try {
    const root = await mkdtemp(join(tmpdir(), 'pac-stalled-acp-'))
    const file = join(root, 'token'); await writeFile(file, 'test-token')
    const url = `ws://127.0.0.1:${server.address().port}`
    const start = Date.now()
    const result = await discoverPacsDirect({ cwd: root, timeoutMs: 100, env: { PAC_NAME: 'testpac', PAC_RELAY_URL: url, PAC_SOURCE_TOKEN_FILE: file, PAC_CONTROLLER_CWD: root } })
    assert.deepEqual(result, { models: [], warnings: [{ name: 'testpac', code: 'unavailable' }] })
    assert.ok(Date.now() - start < 3000)
  } finally { sockets.close(); server.close() }
})
