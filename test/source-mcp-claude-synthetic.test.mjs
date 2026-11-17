import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Duplex } from 'node:stream'
import { spawnContained, stopContained } from '../src/spawn-contained.mjs'
import { createAcpPeer } from '../src/acp-peer.mjs'
import { createSourceMcpSession } from '../src/source-mcp-session.mjs'
import { createSourceMcpPermission } from '../src/source-mcp-permission.mjs'

test('Claude controller routes source MCP via ACP with source permissions', { skip: process.platform !== 'linux' || process.env.PAC_TEST_SYNTHETIC_CLAUDE !== '1', timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-mcp-controller-'))
  let requests = 0, sawResult = false, sawTool = false, remoteSessionId, sourceSession, child, peer
  const operations = [], failures = []
  const permissions = []
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || !request.url.startsWith('/v1/messages')) return response.writeHead(404).end()
    let text = ''; for await (const chunk of request) text += chunk
    const body = JSON.parse(text); requests++
    if (JSON.stringify(body.messages).includes('SOURCE_MCP_MARKER')) sawResult = true
    const tool = body.tools?.find(entry => entry.name === 'mcp__source_tools__read_source_marker')
    if (tool) sawTool = true
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const emit = (type, value) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`)
    emit('message_start', { message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
    if (tool && !sawResult) {
      emit('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_fixture', name: tool.name, input: {} } })
      emit('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } })
    } else {
      emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'SYNTHETIC_DONE' } })
    }
    emit('content_block_stop', { index: 0 })
    emit('message_delta', { delta: { stop_reason: tool && !sawResult ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
    emit('message_stop', {}); response.end()
  })
  try {
    await writeFile(join(root, 'mcp-fixture.txt'), 'SOURCE_MCP_MARKER')
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    child = spawnContained(process.execPath, [fileURLToPath(new URL('../adapters/pac-claude-agent.mjs', import.meta.url))], { cwd: root, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env: {
      ...process.env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: join(root, 'claude'), ANTHROPIC_API_KEY: 'synthetic-test-key', ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, NO_PROXY: '127.0.0.1,localhost', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', PAC_USE_ALIASES: '1', PAC_TEST_ROUTED_SOURCE_MCP: '1' } })
    const permissionClient = { call: async (method, params) => { permissions.push({ method, params }); return { outcome: { outcome: 'selected', optionId: 'allow' } } }, notify() {} }
    peer = createAcpPeer(Duplex.from({ readable: child.stdout, writable: child.stdin }), { timeoutMs: 60000,
      onRequest: async (method, params) => { operations.push(method); if (method === 'session/request_permission') return { outcome: { outcome: 'selected', optionId: params.options.find(option => option.kind === 'allow_once').optionId } }; if (!sourceSession || params.sessionId !== remoteSessionId) throw new Error('Unexpected source request'); try { return await sourceSession.handle(method, params) } catch (error) { failures.push(error.message); throw error } } })
    await peer.call('initialize', { protocolVersion: 1, clientCapabilities: {} })
    const opened = await peer.call('session/new', { cwd: root, mcpServers: [], _meta: { pac: { workspaceCwd: root, sourceMcpServers: ['fixture'] } } })
    remoteSessionId = opened.sessionId
    const config = { fixture: { type: 'local', enabled: true, command: [process.execPath, fileURLToPath(new URL('./fixtures/mock-source-mcp.mjs', import.meta.url))] } }
    sourceSession = createSourceMcpSession({ sourceSessionId: 'source-test', remoteSessionId, cwd: root, resolveConfig: async () => structuredClone(config), verifyProvenance: async () => true,
      requestPermission: createSourceMcpPermission({ sourceSessionId: 'source-test', client: permissionClient }), notify: () => { void peer.call('pac/source_mcp/changed', { sessionId: remoteSessionId, server: 'fixture' }).catch(() => {}) } })
    try { await peer.call('session/prompt', { sessionId: remoteSessionId, prompt: [{ type: 'text', text: 'Use the source marker tool.' }] }, 12000) }
    catch { throw new Error(`Synthetic prompt failed: modelRequests=${requests}, sawTool=${sawTool}, sawResult=${sawResult}, sourceMethods=${JSON.stringify([...new Set(operations)])}, errors=${JSON.stringify([...new Set(failures)])}, permissions=${permissions.length}`) }
    assert.equal(sawTool, true); assert.equal(sawResult, true); assert.ok(requests >= 2)
    assert.deepEqual(permissions.map(entry => entry.params.toolCall.rawInput.server), ['fixture', 'fixture'])
  } finally {
    await sourceSession?.close(); peer?.close(); if (child) stopContained(child)
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})
