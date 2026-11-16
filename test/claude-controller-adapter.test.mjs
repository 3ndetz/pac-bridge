import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { Duplex } from 'node:stream'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createAcpPeer } from '../src/acp-peer.mjs'
import { withEphemeralHookTranscript } from '../src/hook-transcript.mjs'
import { createProjectHooks } from '../src/project-hooks.mjs'

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
  const refusalTest = process.env.PAC_TEST_SYNTHETIC_REFUSAL === '1'
  const settingsTest = process.env.PAC_TEST_SYNTHETIC_SETTINGS === '1'
  let modelEffort, firstModel, fallbackChanged = false
  const notificationTest = process.env.PAC_TEST_SYNTHETIC_NOTIFICATION === '1'
  let notifications = 0, permissionRequests = 0
  const toolTest = process.env.PAC_TEST_SYNTHETIC_TOOL === '1' || notificationTest
  const scopedTest = process.env.PAC_TEST_SYNTHETIC_SCOPED === '1'
  const scopedFailure = process.env.PAC_TEST_SYNTHETIC_SCOPED_FAILURE === '1'
  const promptHookTest = process.env.PAC_TEST_SYNTHETIC_PROMPT_HOOK === '1'
  const lifecycleTest = process.env.PAC_TEST_SYNTHETIC_LIFECYCLE === '1'
  let stopCalls = 0, stopHasTranscript = false, sameSession = false, lifecycleError, lastDecision
  const oldSourceTest = process.env.PAC_TEST_SYNTHETIC_OLD_SOURCE === '1'
  let promptHooks, lifecycleHooks, modelSawHookContext = false
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || !request.url.startsWith('/v1/messages')) { response.writeHead(404).end(); return }
    let body = ''
    for await (const chunk of request) body += chunk
    const parsed = JSON.parse(body), model = parsed.model
    if (settingsTest) modelEffort = parsed.output_config?.effort
    if (!firstModel) firstModel = model
    else if (model !== firstModel) fallbackChanged = true
    if (JSON.stringify(parsed.messages).includes('SYNTHETIC_PROMPT_HOOK_CONTEXT')) modelSawHookContext = true
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
    emit('message_delta', { delta: { stop_reason: tool ? 'tool_use' : refusalTest && requests === 1 ? 'refusal' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })
    emit('message_stop', {})
    response.end()
  })
  let child, peer
  try {
    if (lifecycleTest) {
      await mkdir(join(root, '.claude'))
      const script = `let x='';process.stdin.on('data',c=>x+=c);process.stdin.on('end',()=>{const e=JSON.parse(x),fs=require('fs');fs.readFileSync(e.transcript_path);if(!e.stop_hook_active){process.stderr.write('SYNTHETIC_CONTINUE');process.exitCode=2}})`
      await writeFile(join(root, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: process.execPath, args: ['-e', script] }] }] } }))
      lifecycleHooks = await createProjectHooks({ root, home: root, shell: process.execPath })
    }
    if (promptHookTest) {
      await mkdir(join(root, '.claude'))
      const script = 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{const p=JSON.parse(s).prompt;if(p.includes("BLOCK_ME")){process.stderr.write("blocked by synthetic source hook");process.exitCode=2}else process.stdout.write("SYNTHETIC_PROMPT_HOOK_CONTEXT")})'
      await writeFile(join(root, '.claude', 'settings.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: process.execPath, args: ['-e', script] }] }] } }))
      promptHooks = await createProjectHooks({ root, home: root, shell: process.execPath })
    }
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const adapter = fileURLToPath(new URL('../adapters/pac-claude-agent.mjs', import.meta.url))
    const launch = () => spawn(process.execPath, [adapter], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: {
      ...process.env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: join(root, 'claude'), ANTHROPIC_API_KEY: 'synthetic-test-key',
      ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, NO_PROXY: '127.0.0.1,localhost',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', PAC_USE_ALIASES: '1',
      ...(settingsTest ? { PAC_TEST_SYNTHETIC_SETTINGS: '1' } : {}),
      ...(promptHookTest || oldSourceTest || lifecycleTest || notificationTest ? { PAC_TEST_PROJECT_HOOKS: '1' } : {}),
    } })
    const connect = () => {
      child = launch()
      child.stderr.resume()
      return createAcpPeer(Duplex.from({ readable: child.stdout, writable: child.stdin }), { timeoutMs: 60000,
      onNotification: (method, params) => { if (method === 'session/update' && params?.update?.sessionUpdate === 'agent_message_chunk') answer += params.update.content?.text || '' },
      onRequest: async (method, params) => {
        if (method === 'pac/hooks/dispatch' && notificationTest) {
          if (params.input.hook_event_name === 'Notification') notifications++
          if (params.input.hook_event_name === 'PreToolUse') return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } }
          return {}
        }
        if (method === 'session/request_permission' && notificationTest) { permissionRequests++; return { outcome: { outcome: 'selected', optionId: params.options[0].optionId } } }
        if (method === 'pac/hooks/dispatch' && lifecycleTest) {
          if (params.input.hook_event_name === 'Stop') {
            stopCalls++
            sameSession = params.input.session_id === params.sessionId
            stopHasTranscript = params.input.transcript_path === '' && typeof params.transcript === 'string'
            try { lastDecision = await withEphemeralHookTranscript(params.transcript, path => lifecycleHooks.dispatch({ ...params.input, transcript_path: path })); return lastDecision } catch (error) { lifecycleError = error.message; throw error }
          }
          return {}
        }
        if (method === 'pac/hooks/dispatch' && promptHookTest) return promptHooks.dispatch(params.input)
        if (method === 'pac/instructions/match' && scopedTest && params.path === join(root, 'synthetic.txt')) {
          scopedRequests++
          if (scopedFailure) throw new Error('Synthetic source instruction failure')
          return { instructions: [{ path: 'scoped-rule.md', content: 'SYNTHETIC_SCOPED_RULE' }] }
        }
        if (method !== 'fs/read_text_file' || params.path !== join(root, 'synthetic.txt')) throw new Error('Unexpected source operation')
        toolCalls++
        return { content: 'SYNTHETIC_SOURCE_CONTENT' }
      } })
    }
    peer = connect()
    await peer.call('initialize', { protocolVersion: 1, clientCapabilities: {} })
    const session = await peer.call('session/new', { cwd: root, mcpServers: [], _meta: { pac: { workspaceCwd: root, ...(scopedTest ? { scopedRules: true } : {}), ...(promptHookTest ? { promptHooks: true } : {}), ...(lifecycleTest ? { stopHooks: true } : {}), ...(notificationTest ? { notificationHooks: true } : {}), ...(settingsTest ? { claudeSettings: { effortLevel: 'high', switchModelsOnFlag: process.env.PAC_TEST_SWITCH_ON === '1', env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } } } : {}) } } })
    if (promptHookTest) {
      assert.deepEqual(await peer.call('pac/hooks/capabilities', { sessionId: session.sessionId }), { promptSubmit: true })
      await peer.call('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'BLOCK_ME' }] }, 90000)
      assert.equal(requests, 0, 'Blocked prompt must not reach the model')
    }
    const promptCall = peer.call('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Reply with the local marker.' }] }, 90000)
    let promptError
    if (lifecycleTest) {
      try { await promptCall } catch (error) { promptError = error }
    } else await promptCall
    assert.ok(requests > 0)
    assert.match(answer, scopedFailure ? /could not load source instructions/ : /LOCAL_SYNTHETIC_CLAUDE_OK/)
    if (scopedFailure) { assert.doesNotMatch(answer, /LOCAL_SYNTHETIC_CLAUDE_OK/); assert.equal(requests, 1) }
    if (toolTest) { if (!scopedFailure) { assert.ok(requests >= 2); assert.equal(modelSawSource, true) }; assert.equal(toolCalls, 1) }
    if (scopedTest) { assert.equal(scopedRequests, 1); if (!scopedFailure) assert.equal(modelSawScopedRule, true) }
    if (refusalTest) { assert.equal(requests, 2); assert.equal(fallbackChanged, false) }
    if (settingsTest) { assert.equal((await peer.call('pac/hooks/capabilities', { sessionId: session.sessionId })).settings, true); assert.equal(modelEffort, 'high') }
    if (promptHookTest) assert.equal(modelSawHookContext, true)
    if (notificationTest) { assert.ok(permissionRequests > 0); assert.equal(notifications, 0) }
    if (lifecycleTest) {
      if (process.platform !== 'win32') {
        assert.ok(stopCalls >= 2); assert.equal(promptError, undefined); assert.equal(stopHasTranscript, true); assert.equal(sameSession, true); assert.ok(requests >= 2)
        const before = stopCalls
        peer.close(); child.kill()
        await new Promise(resolve => child.once('exit', resolve))
        peer = connect()
        await peer.call('initialize', { protocolVersion: 1, clientCapabilities: {} })
        await peer.call('session/load', { sessionId: session.sessionId, cwd: root, mcpServers: [], _meta: { pac: { workspaceCwd: root, stopHooks: true } } }, 90000)
        await peer.call('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Resume the synthetic session.' }] }, 90000)
        assert.ok(stopCalls >= before + 2, 'restored session must dispatch Stop and continue on block')
      } else { assert.ok(promptError); assert.equal(requests, 1); assert.match(answer, /could not execute a source Stop hook/) }
    }
  } finally {
    peer?.close(); child?.kill(); await new Promise((resolve) => server.close(resolve))
    const actual = await realpath(root), local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-controller-test-')) await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
