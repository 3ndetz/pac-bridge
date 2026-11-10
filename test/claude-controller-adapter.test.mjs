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
import { createAcpPeer } from '../src/acp-peer.mjs'

test('initializes the Claude controller with project dependencies without signing in', { timeout: 30000 }, async () => {
  const adapter = fileURLToPath(new URL('../adapters/pac-claude-agent.mjs', import.meta.url))
  const child = spawn(process.execPath, [adapter], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  child.stderr.resume()
  const peer = createAcpPeer(Duplex.from({ readable: child.stdout, writable: child.stdin }))
  try {
    const result = await peer.call('initialize', { protocolVersion: 1, clientCapabilities: {} })
    assert.equal(result.protocolVersion, 1)
  } finally { peer.close(); child.kill() }
})

test('runs the installed controller against a local synthetic model endpoint', { skip: process.env.PAC_TEST_SYNTHETIC_CLAUDE !== '1', timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-controller-test-'))
  let requests = 0, answer = '', toolCalls = 0, modelSawSource = false, modelSawScopedRule = false, scopedRequests = 0
  const toolTest = process.env.PAC_TEST_SYNTHETIC_TOOL === '1'
  const scopedTest = process.env.PAC_TEST_SYNTHETIC_SCOPED === '1'
  const scopedFailure = process.env.PAC_TEST_SYNTHETIC_SCOPED_FAILURE === '1'
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || !request.url.startsWith('/v1/messages')) { response.writeHead(404).end(); return }
    let body = ''
    for await (const chunk of request) body += chunk
    const parsed = JSON.parse(body), model = parsed.model
    if (JSON.stringify(parsed.messages).includes('SYNTHETIC_SOURCE_CONTENT')) modelSawSource = true
    if (JSON.stringify(parsed.messages).includes('SYNTHETIC_SCOPED_RULE')) modelSawScopedRule = true
    requests++
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const emit = (type, value) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`)
    emit('message_start', { message: { id: 'msg_synthetic', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
    const tool = toolTest && requests === 1 && parsed.tools?.find((entry) => entry.name === 'mcp__pac__Read' || entry.name === 'Read')
    if (toolTest && requests === 1 && !tool) { response.destroy(); return }
    if (tool) {
      emit('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_synthetic', name: tool.name, input: {} } })
      emit('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: join(root, 'synthetic.txt') }) } })
    } else {
      emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'LOCAL_SYNTHETIC_CLAUDE_OK' } })
    }
    emit('content_block_stop', { index: 0 })
    emit('message_delta', { delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })
    emit('message_stop', {})
    response.end()
  })
  let child, peer
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const adapter = fileURLToPath(new URL('../adapters/pac-claude-agent.mjs', import.meta.url))
    child = spawn(process.execPath, [adapter], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: {
      ...process.env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: join(root, 'claude'), ANTHROPIC_API_KEY: 'synthetic-test-key',
      ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, NO_PROXY: '127.0.0.1,localhost',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', PAC_USE_ALIASES: '1',
    } })
    child.stderr.resume()
    peer = createAcpPeer(Duplex.from({ readable: child.stdout, writable: child.stdin }), { timeoutMs: 60000,
      onNotification: (method, params) => { if (method === 'session/update' && params?.update?.sessionUpdate === 'agent_message_chunk') answer += params.update.content?.text || '' },
      onRequest: async (method, params) => {
        if (method === 'pac/instructions/match' && scopedTest && params.path === join(root, 'synthetic.txt')) {
          scopedRequests++
          if (scopedFailure) throw new Error('Synthetic source instruction failure')
          return { instructions: [{ path: 'scoped-rule.md', content: 'SYNTHETIC_SCOPED_RULE' }] }
        }
        if (method !== 'fs/read_text_file' || params.path !== join(root, 'synthetic.txt')) throw new Error('Unexpected source operation')
        toolCalls++
        return { content: 'SYNTHETIC_SOURCE_CONTENT' }
      } })
    await peer.call('initialize', { protocolVersion: 1, clientCapabilities: {} })
    const session = await peer.call('session/new', { cwd: root, mcpServers: [], ...(scopedTest ? { _meta: { pac: { scopedRules: true } } } : {}) })
    await peer.call('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Reply with the local marker.' }] }, 90000)
    assert.ok(requests > 0)
    assert.match(answer, scopedFailure ? /could not load source instructions/ : /LOCAL_SYNTHETIC_CLAUDE_OK/)
    if (scopedFailure) { assert.doesNotMatch(answer, /LOCAL_SYNTHETIC_CLAUDE_OK/); assert.equal(requests, 1) }
    if (toolTest) { if (!scopedFailure) { assert.ok(requests >= 2); assert.equal(modelSawSource, true) }; assert.equal(toolCalls, 1) }
    if (scopedTest) { assert.equal(scopedRequests, 1); if (!scopedFailure) assert.equal(modelSawScopedRule, true) }
  } finally {
    peer?.close(); child?.kill(); await new Promise((resolve) => server.close(resolve))
    const actual = await realpath(root), local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-controller-test-')) await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
