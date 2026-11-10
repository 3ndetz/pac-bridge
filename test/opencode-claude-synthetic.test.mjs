import assert from 'node:assert/strict'
import { once } from 'node:events'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { attachAcpRelay } from '../src/acp-relay.mjs'
import { startAgent } from '../src/acp-transport.mjs'
import { spawnContained, stopContained } from '../src/spawn-contained.mjs'

test('installed OpenCode reaches the installed Claude SDK and source workspace through a synthetic model', {
  skip: !process.env.PAC_OPENCODE_BINARY, timeout: 120000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-full-synthetic-'))
  const relayServer = createServer()
  const relay = attachAcpRelay(relayServer, { authorize: () => true })
  let requests = 0, sawSource = false, agent, child
  const agentErrors = []
  const modelServer = createServer(async (request, response) => {
    if (request.method !== 'POST' || !request.url.startsWith('/v1/messages')) { response.writeHead(404).end(); return }
    let body = ''
    for await (const chunk of request) body += chunk
    const parsed = JSON.parse(body)
    if (JSON.stringify(parsed.messages).includes('PAC_SOURCE_SYNTHETIC_CONTENT')) sawSource = true
    const tool = requests++ === 0 && parsed.tools?.find((entry) => entry.name === 'mcp__pac__Read' || entry.name === 'Read')
    if (requests === 1 && !tool) { response.destroy(); return }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const emit = (type, value) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`)
    emit('message_start', { message: { id: `msg_synthetic_${requests}`, type: 'message', role: 'assistant', model: parsed.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
    if (tool) {
      emit('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_synthetic', name: tool.name, input: {} } })
      emit('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: join(root, 'workspace', 'fixture.txt') }) } })
    } else {
      emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'PAC_FULL_SYNTHETIC_OK' } })
    }
    emit('content_block_stop', { index: 0 })
    emit('message_delta', { delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })
    emit('message_stop', {}); response.end()
  })
  try {
    await mkdir(join(root, 'controller'))
    await mkdir(join(root, 'workspace'))
    await writeFile(join(root, 'workspace', 'fixture.txt'), 'PAC_SOURCE_SYNTHETIC_CONTENT')
    const tokenFile = join(root, 'token'); await writeFile(tokenFile, 'synthetic-token')
    modelServer.listen(0, '127.0.0.1'); await once(modelServer, 'listening')
    relayServer.listen(0, '127.0.0.1'); await once(relayServer, 'listening')
    const url = `ws://127.0.0.1:${relayServer.address().port}`
    const adapter = fileURLToPath(new URL('../adapters/pac-claude-agent.mjs', import.meta.url))
    agent = await startAgent({ url, name: 'synthetic', token: 'synthetic-token', command: process.execPath, args: [adapter], cwd: join(root, 'controller'), onError: (error) => agentErrors.push(error.message), env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, COMSPEC: process.env.COMSPEC, TEMP: root, TMP: root, HOME: join(root, 'controller'), USERPROFILE: join(root, 'controller'), CLAUDE_CONFIG_DIR: join(root, 'controller', 'claude'),
      ANTHROPIC_API_KEY: 'synthetic-test-key', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: `http://127.0.0.1:${modelServer.address().port}`,
      NO_PROXY: '127.0.0.1,localhost', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    } })
    const launcher = fileURLToPath(new URL('../adapters/opencode-pac.mjs', import.meta.url))
    const env = { PATH: process.env.PATH, PATHEXT: process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD', SystemRoot: process.env.SystemRoot,
      COMSPEC: process.env.COMSPEC, TEMP: root, TMP: root, HOME: root, USERPROFILE: root, APPDATA: join(root, 'appdata'),
      LOCALAPPDATA: join(root, 'localappdata'), XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
      XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'), OPENCODE_DISABLE_MODELS_FETCH: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1', PAC_EXPERIMENTAL: '1', PAC_OPENCODE_BINARY: process.env.PAC_OPENCODE_BINARY,
      PAC_MODEL: 'PAC_synthetic/sonnet', PAC_SOURCE_BASH: process.platform === 'win32' ? join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe') : '/bin/bash',
      PAC_RELAY_URL: url, PAC_NAME: 'synthetic', PAC_SOURCE_TOKEN_FILE: tokenFile, PAC_CONTROLLER_CWD: join(root, 'controller'), PAC_DIAGNOSTICS: '1', PAC_TRACE_PATH: join(root, 'trace') }
    child = spawnContained(process.execPath, [launcher, 'run', '--format', 'json', 'Read the fixture'], { cwd: join(root, 'workspace'), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let output = '', errors = ''
    child.stdout.on('data', (chunk) => { output += chunk }); child.stderr.on('data', (chunk) => { errors += chunk })
    const deadline = setTimeout(() => stopContained(child), 90000)
    const [code] = await once(child, 'close'); clearTimeout(deadline)
    let trace = ''
    try { trace = await readFile(join(root, 'trace'), 'utf8') } catch {}
    assert.equal(code, 0, `${errors.slice(-1000)}\n${output.slice(-1000)}\n${trace.slice(-1500)}\nrequests: ${requests}; agent errors: ${agentErrors.join('; ')}`)
    assert.match(output, /PAC_FULL_SYNTHETIC_OK/)
    assert.ok(requests >= 2)
    assert.equal(sawSource, true)
  } finally {
    if (child && child.exitCode === null) stopContained(child)
    agent?.close(); relay.close(); relayServer.close(); await new Promise((resolve) => modelServer.close(resolve))
    const actual = realpathSync.native(root), local = relative(realpathSync.native(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-full-synthetic-')) await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
