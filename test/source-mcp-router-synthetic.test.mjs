import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { attachAcpRelay } from '../src/acp-relay.mjs'
import { startAgent } from '../src/acp-transport.mjs'
import { openOpencodeAcpSession } from '../src/opencode-acp-session.mjs'

test('router and controller enforce source MCP permissions across isolated sessions', { skip: process.platform !== 'linux' || process.env.PAC_TEST_SYNTHETIC_CLAUDE !== '1', timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-mcp-router-'))
  const relayHttp = createServer(), relay = attachAcpRelay(relayHttp, { authorize: () => true })
  const permissions = [], sessions = []
  let agent, modelRequests = 0
  const model = createServer(async (request, response) => {
    if (request.method !== 'POST' || !request.url.startsWith('/v1/messages')) return response.writeHead(404).end()
    let text = ''; for await (const chunk of request) text += chunk
    const body = JSON.parse(text); modelRequests++
    const done = JSON.stringify(body.messages).includes('SOURCE_ROUTER_MARKER')
    const tool = body.tools?.find(entry => entry.name === 'mcp__source_tools__read_source_marker')
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const emit = (type, value) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`)
    emit('message_start', { message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
    if (tool && !done) {
      emit('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_fixture', name: tool.name, input: {} } })
      emit('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } })
    } else {
      emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'SYNTHETIC_DONE' } })
    }
    emit('content_block_stop', { index: 0 }); emit('message_delta', { delta: { stop_reason: tool && !done ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }); emit('message_stop', {}); response.end()
  })
  try {
    const workspace = join(root, 'workspace'); await mkdir(workspace)
    await writeFile(join(workspace, 'mcp-fixture.txt'), 'SOURCE_ROUTER_MARKER')
    await writeFile(join(root, 'token'), 'synthetic-relay-token')
    relayHttp.listen(0, '127.0.0.1'); model.listen(0, '127.0.0.1'); await Promise.all([once(relayHttp, 'listening'), once(model, 'listening')])
    const url = `ws://127.0.0.1:${relayHttp.address().port}`
    const env = { ...process.env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: join(root, 'controller-config'), ANTHROPIC_API_KEY: 'synthetic-test-key', ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${model.address().port}`, NO_PROXY: '127.0.0.1,localhost', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', PAC_USE_ALIASES: '1', PAC_TEST_ROUTED_SOURCE_MCP: '1' }
    const controller = fileURLToPath(new URL('../adapters/pac-claude-agent.mjs', import.meta.url))
    agent = await startAgent({ url, name: 'testpac', token: 'synthetic-relay-token', command: process.execPath, args: [controller], cwd: root, env })
    const router = fileURLToPath(new URL('../adapters/pac-opencode-router.mjs', import.meta.url))
    const fake = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))
    const run = async (label, resumeSessionId) => {
      const session = await openOpencodeAcpSession({ command: process.execPath, args: [router, fake, '--native'], cwd: workspace,
        env: { ...env, PAC_EXPERIMENTAL: '1', PAC_OPENCODE_BINARY: process.execPath, PAC_RELAY_URL: url, PAC_NAME: 'testpac', PAC_SOURCE_TOKEN_FILE: join(root, 'token'), PAC_CONTROLLER_CWD: root, PAC_SESSION_DIR: join(root, `bindings-${label}`) },
        ...(resumeSessionId ? { resumeSessionId } : {}), model: 'PAC_testpac/sonnet', onPermission: async params => { permissions.push({ label, title: params.toolCall?.title }); return { outcome: { outcome: 'selected', optionId: params.options.find(option => option.kind === 'allow_once').optionId } } } })
      sessions.push(session)
      const events = []
      await session.prompt([{ type: 'text', text: 'Use the source MCP marker tool.' }], event => events.push(event))
      assert.match(JSON.stringify(events), /SYNTHETIC_DONE/)
      return session
    }
    const first = await run('one'); await run('two')
    const sourceSessionId = first.sourceSessionId
    first.close()
    await run('one', sourceSessionId)
    for (const label of ['one', 'two']) {
      const entries = permissions.filter(item => item.label === label)
      assert.ok(entries.some(item => item.title?.startsWith('Start source MCP:')))
      assert.ok(entries.some(item => item.title?.startsWith('Source MCP:')))
    }
    assert.ok(modelRequests >= 4)
  } finally {
    for (const session of sessions) session.close()
    agent?.close(); relay.close(); relayHttp.close(); model.close()
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 })
  }
})
