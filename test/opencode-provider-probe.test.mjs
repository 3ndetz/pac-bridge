import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import test from 'node:test'
import { spawnContained, stopContained } from '../src/spawn-contained.mjs'

// This establishes only the local provider boundary, using a synthetic model.
// It does not establish PAC routing or interactive tool fidelity.
test('installed OpenCode can select a local synthetic provider', {
  skip: !process.env.PAC_OPENCODE_BINARY, timeout: 90000
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-opencode-provider-'))
  const requests = []
  let toolIssued = false
  await writeFile(join(root, 'probe.txt'), 'LOCAL_TOOL_FIXTURE')
  const plugin = new URL('../adapters/opencode-plugin.mjs', import.meta.url).href
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    let body = ''
    for await (const chunk of request) body += chunk
    const requestBody = JSON.parse(body)
    requestBody.observedHeaders = { session: request.headers['x-pac-session-id'], message: request.headers['x-pac-message-id'] }
    requests.push(requestBody)
    const chunk = (value) => `data: ${JSON.stringify(value)}\n\n`
    const base = { id: 'local-probe', object: 'chat.completion.chunk', created: 1, model: 'synthetic' }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (!toolIssued && requestBody.tools?.some((tool) => tool.function?.name === 'read')) {
      toolIssued = true
      response.write(chunk({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'probe-read', type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: join(root, 'probe.txt') }) } }] }, finish_reason: null }] }))
      response.write(chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }))
    } else {
      response.write(chunk({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'PAC local probe response' }, finish_reason: null }] }))
      response.write(chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
    }
    response.end('data: [DONE]\n\n')
  })
  let child
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const config = { plugin: [plugin], provider: { pacbridge: { npm: '@ai-sdk/openai-compatible', name: 'PAC local probe',
      options: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'synthetic' },
      models: { synthetic: { name: 'Synthetic' } } } } }
    const env = { PATH: process.env.PATH, PATHEXT: process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD',
      SystemRoot: process.env.SystemRoot, COMSPEC: process.env.COMSPEC, TEMP: root, TMP: root,
      HOME: root, USERPROFILE: root, APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'), XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_MODELS_FETCH: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1' }
    child = spawnContained(process.env.PAC_OPENCODE_BINARY, ['run', '--format', 'json', '-m', 'pacbridge/synthetic', 'Read the probe file'],
      { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let output = ''
    let errors = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { errors += chunk })
    const [code] = await once(child, 'close')
    assert.equal(code, 0, errors.slice(-3000))
    assert.equal(requests[0]?.model, 'synthetic')
    assert.ok(toolIssued)
    assert.ok(requests.some((request) => request.observedHeaders.session && request.observedHeaders.message))
    const userRequest = requests.find((request) => request.observedHeaders.session && request.messages.at(-1)?.role === 'user')
    assert.equal(typeof userRequest?.messages.at(-1)?.content, 'string')
    const toolResult = requests.flatMap((request) => request.messages.filter((message) => message.role === 'tool'))
    assert.match(JSON.stringify(toolResult), /LOCAL_TOOL_FIXTURE/)
    assert.match(output, /probe-read/)
    assert.match(output, /PAC local probe response/)
  } finally {
    if (child && child.exitCode === null) stopContained(child)
    await new Promise((resolve) => server.close(resolve))
    const actual = await realpath(root)
    const local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-opencode-provider-')) await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
