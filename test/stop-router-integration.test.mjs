import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { attachAcpRelay } from '../src/acp-relay.mjs'
import { startAgent } from '../src/acp-transport.mjs'
import { openOpencodeAcpSession } from '../src/opencode-acp-session.mjs'

test('forwards Stop through router to source and continues a blocked turn', { skip: process.platform !== 'linux' || process.env.PAC_TEST_SYNTHETIC_CLAUDE !== '1', timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-stop-router-'))
  const relayServer = createServer(), relay = attachAcpRelay(relayServer, { authorize: () => true })
  let requests = 0, sawEffort = false, agent, session
  const modelServer = createServer(async (request, response) => {
    if (request.method !== 'POST' || !request.url.startsWith('/v1/messages')) { response.writeHead(404).end(); return }
    let input = ''
    for await (const chunk of request) input += chunk
    const parsed = JSON.parse(input), model = parsed.model
    sawEffort ||= parsed.output_config?.effort === 'high'
    requests++
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const emit = (type, value) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`)
    emit('message_start', { message: { id: 'msg_test', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
    emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'SYNTHETIC_STOP_RESULT' } })
    emit('content_block_stop', { index: 0 })
    emit('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })
    emit('message_stop', {})
    response.end()
  })
  try {
    await mkdir(join(root, '.claude'))
    const script = String.raw`let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{const e=JSON.parse(s),f=require('fs');f.readFileSync(e.transcript_path);if(process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC!=='1')process.exit(1);f.appendFileSync('stop-events',e.stop_hook_active?'continued\n':'initial\n');if(!e.stop_hook_active){process.stderr.write('continue test');process.exitCode=2}})`
    await writeFile(join(root, '.claude', 'settings.json'), JSON.stringify({ effortLevel: 'high', env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: process.execPath, args: ['-e', script] }] }] } }))
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
      PAC_TEST_SYNTHETIC_LIFECYCLE: '1', PAC_USE_ALIASES: '1' }
    delete env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
    agent = await startAgent({ url, name: 'testpac', token: 'synthetic-relay-token', command: process.execPath, args: [controller], cwd: root, env })
    const openSession = resumeSessionId => openOpencodeAcpSession({ command: process.execPath, args: [router, fake, '--native'], cwd: root,
      env: { ...env, PAC_EXPERIMENTAL: '1', PAC_EXPERIMENTAL_HOOKS: '1', PAC_SOURCE_BASH: '/bin/bash',
        PAC_OPENCODE_BINARY: process.execPath, PAC_RELAY_URL: url, PAC_NAME: 'testpac', PAC_SOURCE_TOKEN_FILE: join(root, 'token'), PAC_CONTROLLER_CWD: root, PAC_SESSION_DIR: join(root, 'sessions') },
      resumeSessionId, model: 'PAC_testpac/sonnet', onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })
    session = await openSession()
    const events = []
    assert.equal((await session.prompt([{ type: 'text', text: 'Respond briefly.' }], value => events.push(value))).stopReason, 'end_turn')
    assert.ok(requests >= 2)
    assert.equal(sawEffort, true)
    assert.match(await readFile(join(root, 'stop-events'), 'utf8'), /initial\ncontinued/)
    assert.match(JSON.stringify(events), /SYNTHETIC_STOP_RESULT/)
    const sessionId = session.sourceSessionId
    session.close()
    session = await openSession(sessionId)
    assert.equal((await session.prompt([{ type: 'text', text: 'Resume the same session.' }], () => {})).stopReason, 'end_turn')
    assert.match(await readFile(join(root, 'stop-events'), 'utf8'), /initial\ncontinued\ninitial\ncontinued/)
    assert.ok(requests >= 4)
    await writeFile(join(root, '.claude', 'settings.json'), JSON.stringify({ effortLevel: 'high', env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: process.execPath, args: ['-e', 'process.exit(1)'] }] }] } }))
    await assert.rejects(session.prompt([{ type: 'text', text: 'The hook should fail.' }], () => {}))
  } finally {
    session?.close(); agent?.close(); relay.close(); relayServer.close(); modelServer.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
