import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { attachAcpRelay } from '../src/acp-relay.mjs'
import { startAgent } from '../src/acp-transport.mjs'
import { openOpencodeAcpSession } from '../src/opencode-acp-session.mjs'

test('does not execute local Claude async hooks or inject their context into OpenCode', { skip: process.platform !== 'linux' || process.env.PAC_TEST_SYNTHETIC_CLAUDE !== '1', timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-stop-router-'))
  const relayServer = createServer(), relay = attachAcpRelay(relayServer, { authorize: () => true })
  let requests = 0, sawAsyncContext = false, agent, session
  const modelServer = createServer(async (request, response) => {
    if (request.method !== 'POST' || !request.url.startsWith('/v1/messages')) { response.writeHead(404).end(); return }
    let input = ''
    for await (const chunk of request) input += chunk
    const parsed = JSON.parse(input), model = parsed.model
    sawAsyncContext ||= JSON.stringify(parsed.messages).includes('ASYNC_SOURCE_CONTEXT')
    requests++
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const emit = (type, value) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`)
    emit('message_start', { message: { id: 'msg_test', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
    emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'SYNTHETIC_ASYNC_RESULT' } })
    emit('content_block_stop', { index: 0 })
    emit('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })
    emit('message_stop', {})
    response.end()
  })
  try {
    await mkdir(join(root, '.claude'))
    const script = `require('node:fs').writeFileSync(${JSON.stringify(join(root,'local-hook-executed'))},'executed');process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:'ASYNC_SOURCE_CONTEXT'},decision:'block'})),700))`
    await writeFile(join(root, '.claude', 'settings.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: process.execPath, args: ['-e', script], async: true }] }] } }))
    await writeFile(join(root, 'token'), 'synthetic-relay-token')
    relayServer.listen(0, '127.0.0.1'); modelServer.listen(0, '127.0.0.1')
    await Promise.all([once(relayServer, 'listening'), once(modelServer, 'listening')])
    const url = `ws://127.0.0.1:${relayServer.address().port}`
    const controller = fileURLToPath(new URL('../adapters/pac-claude-agent.mjs', import.meta.url))
    const router = fileURLToPath(new URL('../adapters/pac-opencode-router.mjs', import.meta.url))
    const fake = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))
    const env = { ...process.env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: join(root, 'controller-config'),
      ANTHROPIC_API_KEY: 'synthetic-test-key', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: `http://127.0.0.1:${modelServer.address().port}`,
      NO_PROXY: '127.0.0.1,localhost', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', PAC_TEST_PROJECT_HOOKS: '1',
      PAC_TEST_ASYNC_HOOKS: '1', PAC_USE_ALIASES: '1' }
    delete env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
    agent = await startAgent({ url, name: 'testpac', token: 'synthetic-relay-token', command: process.execPath, args: [controller], cwd: root, env })
    const openSession = resumeSessionId => openOpencodeAcpSession({ command: process.execPath, args: [router, fake, '--native'], cwd: root,
      env: { ...env, PAC_EXPERIMENTAL: '1', PAC_EXPERIMENTAL_HOOKS: '1', PAC_SOURCE_BASH: '/bin/bash',
        PAC_OPENCODE_BINARY: process.execPath, PAC_RELAY_URL: url, PAC_NAME: 'testpac', PAC_SOURCE_TOKEN_FILE: join(root, 'token'), PAC_CONTROLLER_CWD: root, PAC_SESSION_DIR: join(root, 'sessions') },
      resumeSessionId, model: 'PAC_testpac/sonnet', onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })
    session = await openSession()
    const events = []
    assert.equal((await session.prompt([{ type: 'text', text: 'First synthetic prompt.' }], value => events.push(value))).stopReason, 'end_turn')
    assert.equal(sawAsyncContext, false)
    await new Promise(resolve => setTimeout(resolve, 2500))
    assert.equal((await session.prompt([{ type: 'text', text: 'Second synthetic prompt.' }], value => events.push(value))).stopReason, 'end_turn')
    assert.equal(sawAsyncContext, false)
    await assert.rejects(readFile(join(root,'local-hook-executed'),'utf8'), {code:'ENOENT'})
    assert.ok(requests >= 2)
  } finally {
    session?.close(); agent?.close(); relay.close(); relayServer.close(); modelServer.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
