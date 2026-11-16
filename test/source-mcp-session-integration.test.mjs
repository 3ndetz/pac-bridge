import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createSourceMcpSession } from '../src/source-mcp-session.mjs'
import { createSourceMcpPermission } from '../src/source-mcp-permission.mjs'
import { randomUUID } from 'node:crypto'
import { createControllerSourceMcp } from '../src/source-mcp-controller.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

test('source MCP with ACP permission decisions and revocation', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-mcp-session-'))
  const decisions = ['deny', 'allow', 'deny', 'allow']
  const requests = [], notifications = []
  const client = { call: async (method, params) => { requests.push({ method, params }); return { outcome: { outcome: 'selected', optionId: decisions.shift() } } },
    notify: (...event) => notifications.push(event) }
  const requestPermission = createSourceMcpPermission({ sourceSessionId: 'local-a', client })
  let config = { server: { type: 'local', enabled: true, command: [process.execPath, fileURLToPath(new URL('./fixtures/mock-source-mcp.mjs', import.meta.url))], environment: { PRIVATE_TEST_VALUE: 'do-not-forward' } } }
  let notifyChanged
  const changed = new Promise(resolve => { notifyChanged = resolve })
  const session = createSourceMcpSession({ sourceSessionId: 'local-a', remoteSessionId: 'remote-a', cwd: root,
    resolveConfig: async () => structuredClone(config), verifyProvenance: async () => true, requestPermission, notify: notifyChanged })
  const base = () => ({ sessionId: 'remote-a', server: 'server', operationId: randomUUID() })
  try {
    await writeFile(join(root, 'mcp-fixture.txt'), 'source-marker')
    await assert.rejects(session.handle('pac/source_mcp/list', base()), /not authorized/)
    assert.deepEqual((await session.handle('pac/source_mcp/list', base())).tools.map(tool => tool.name), ['read_source_marker'])
    await assert.rejects(session.handle('pac/source_mcp/call', { ...base(), name: 'read_source_marker', arguments: {} }), /denied/)
    const result = await session.handle('pac/source_mcp/call', { ...base(), name: 'read_source_marker', arguments: {} })
    assert.equal(result.content[0].text, 'source-marker')
    assert.equal((await changed).type, 'tools_changed')
    assert.deepEqual((await session.handle('pac/source_mcp/list', base())).tools.map(tool => tool.name), ['read_source_marker', 'dynamic_marker'])
    config = { ...config, server: { ...config.server, command: ['changed'] } }
    await assert.rejects(session.recheck(), /changed/)
    await assert.rejects(session.handle('pac/source_mcp/list', base()), /unavailable/)
    assert.doesNotMatch(JSON.stringify(requests), /do-not-forward|PRIVATE_TEST_VALUE/)
  } finally { await session.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
})

test('controller MCP proxy reaches the session-bound source and per-call permission', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-mcp-proxy-'))
  const prompts = []
  const hapi = { call: async (method, params) => { prompts.push({ method, params }); return { outcome: { outcome: 'selected', optionId: 'allow' } } }, notify() {} }
  const requestPermission = createSourceMcpPermission({ sourceSessionId: 'local-a', client: hapi })
  const config = { server: { type: 'local', enabled: true, command: [process.execPath, fileURLToPath(new URL('./fixtures/mock-source-mcp.mjs', import.meta.url))] } }
  let bridge
  const session = createSourceMcpSession({ sourceSessionId: 'local-a', remoteSessionId: 'remote-a', cwd: root,
    resolveConfig: async () => structuredClone(config), verifyProvenance: async () => true, requestPermission,
    notify: () => { void bridge.changed().catch(() => {}) } })
  bridge = createControllerSourceMcp({ remoteSessionId: 'remote-a', serverName: 'server', peer: { call: (method, params) => session.handle(method, params) } })
  const client = new Client({ name: 'controller-test', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  try {
    await writeFile(join(root, 'mcp-fixture.txt'), 'source-marker')
    await Promise.all([bridge.config.instance.connect(a), client.connect(b)])
    assert.equal((await client.listTools()).tools[0].name, 'read_source_marker')
    assert.equal((await client.callTool({ name: 'read_source_marker', arguments: {} })).content[0].text, 'source-marker')
    assert.deepEqual(prompts.map(entry => entry.params.sessionId), ['local-a', 'local-a'])
    assert.deepEqual(prompts.map(entry => entry.params.toolCall.rawInput.server), ['server', 'server'])
  } finally { await client.close(); await bridge.close(); await session.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
})
