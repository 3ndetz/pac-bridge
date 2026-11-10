import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { Duplex } from 'node:stream'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { attachAcpRelay } from '../src/acp-relay.mjs'
import { createAcpPeer } from '../src/acp-peer.mjs'
import { startAgent } from '../src/acp-transport.mjs'
import { createSessionStore } from '../src/session-store.mjs'

test('serializes model selection and binds the final choice to the session', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-selection-'))
  const server = createServer()
  const relay = attachAcpRelay(server, { authorize: () => true })
  let agent, child, peer
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const url = `ws://127.0.0.1:${server.address().port}`
    const fake = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))
    const router = fileURLToPath(new URL('./fixtures/opencode-acp-router.mjs', import.meta.url))
    agent = await startAgent({ url, name: 'testpac', token: 'test-token', command: process.execPath, args: [fake] })
    const { writeFile } = await import('node:fs/promises')
    const tokenFile = join(root, 'token')
    await writeFile(tokenFile, 'test-token')
    child = spawn(process.execPath, [router, fake, '--native'], { env: { ...process.env, PAC_EXPERIMENTAL: '1',
      PAC_OPENCODE_BINARY: process.execPath, PAC_RELAY_URL: url, PAC_NAME: 'testpac', PAC_SOURCE_TOKEN_FILE: tokenFile,
      PAC_CONTROLLER_CWD: root, PAC_SESSION_DIR: join(root, 'records') }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    child.stderr.resume()
    peer = createAcpPeer(Duplex.from({ readable: child.stdout, writable: child.stdin }))
    await peer.call('initialize', { protocolVersion: 1, clientCapabilities: {} })
    const opened = await peer.call('session/new', { cwd: root, mcpServers: [] })
    const first = peer.call('session/set_config_option', { sessionId: opened.sessionId, configId: 'model', value: 'PAC_testpac/sonnet' })
    const second = peer.call('session/set_config_option', { sessionId: opened.sessionId, configId: 'model', value: 'PAC_testpac/opus' })
    const prompt = peer.call('session/prompt', { sessionId: opened.sessionId, prompt: [] })
    await Promise.all([first, second])
    assert.deepEqual(await prompt, { selected: 'opus' })
    assert.equal((await createSessionStore(join(root, 'records')).read(opened.sessionId)).model, 'opus')
    await assert.rejects(peer.call('session/set_config_option', { sessionId: opened.sessionId, configId: 'model', value: 'PAC_testpac/missing' }), /unavailable/)
    await assert.rejects(peer.call('session/prompt', { sessionId: opened.sessionId, prompt: [] }), /model selection failed/)
    await peer.call('session/set_config_option', { sessionId: opened.sessionId, configId: 'model', value: 'PAC_testpac/sonnet' })
    assert.deepEqual(await peer.call('session/prompt', { sessionId: opened.sessionId, prompt: [] }), { selected: 'sonnet' })
    peer.close()
    child.kill()
    await once(child, 'exit')
    child = spawn(process.execPath, [router, fake, '--native'], { env: { ...process.env, PAC_EXPERIMENTAL: '1',
      PAC_OPENCODE_BINARY: process.execPath, PAC_RELAY_URL: url, PAC_NAME: 'testpac', PAC_SOURCE_TOKEN_FILE: tokenFile,
      PAC_CONTROLLER_CWD: root, PAC_SESSION_DIR: join(root, 'records') }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    child.stderr.resume()
    peer = createAcpPeer(Duplex.from({ readable: child.stdout, writable: child.stdin }))
    await peer.call('initialize', { protocolVersion: 1, clientCapabilities: {} })
    const restored = await peer.call('session/load', { sessionId: opened.sessionId, cwd: root, mcpServers: [] })
    assert.equal(restored.models.currentModelId, 'PAC_testpac/sonnet')
    assert.deepEqual(await peer.call('session/prompt', { sessionId: opened.sessionId, prompt: [] }), { selected: 'sonnet' })
    await assert.rejects(peer.call('session/load', { sessionId: opened.sessionId, cwd: tmpdir(), mcpServers: [] }), /workspace has changed/)
    await assert.rejects(peer.call('session/load', { sessionId: 'unknown', cwd: root, mcpServers: [] }), /binding is unavailable/)
    await assert.rejects(peer.call('session/new', { cwd: root, mcpServers: [] }), /refusing to start/)
  } finally {
    peer?.close()
    child?.kill()
    agent?.close()
    relay.close()
    server.close()
    const actual = await realpath(root)
    const local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-selection-')) await rm(actual, { recursive: true, force: true })
  }
})
