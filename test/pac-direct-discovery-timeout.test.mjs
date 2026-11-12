import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import test from 'node:test'
import { WebSocketServer } from 'ws'
import { discoverPacsDirect } from '../src/pac-direct-discovery.mjs'
import { connectSource } from '../src/acp-transport.mjs'

test('does not advertise PAC when a workspace has unsupported OpenCode hooks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-policy-discovery-'))
  try {
    const plugins = join(root, '.opencode', 'plugins')
    await mkdir(plugins, { recursive: true })
    await writeFile(join(plugins, 'example.js'), 'export default async () => ({})')
    const result = await discoverPacsDirect({ cwd: root, env: { PAC_NAME: 'testpac', PAC_RELAY_URL: 'ws://127.0.0.1:1',
      PAC_SOURCE_TOKEN_FILE: join(root, 'missing-token'), PAC_CONTROLLER_CWD: root } })
    assert.deepEqual(result, { models: [], warnings: [{ name: 'testpac', code: 'opencode_policy_unsupported' }] })
  } finally {
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
