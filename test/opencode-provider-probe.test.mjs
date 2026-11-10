import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
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
  let requestBody
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    let body = ''
    for await (const chunk of request) body += chunk
    requestBody = JSON.parse(body)
    const chunk = (value) => `data: ${JSON.stringify(value)}\n\n`
    const base = { id: 'local-probe', object: 'chat.completion.chunk', created: 1, model: 'synthetic' }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(chunk({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'PAC local probe response' }, finish_reason: null }] }))
    response.write(chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
    response.end('data: [DONE]\n\n')
  })
  let child
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const config = { provider: { pacprobe: { npm: '@ai-sdk/openai-compatible', name: 'PAC local probe',
      options: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'synthetic' },
      models: { synthetic: { name: 'Synthetic' } } } } }
    const env = { PATH: process.env.PATH, PATHEXT: process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD',
      SystemRoot: process.env.SystemRoot, COMSPEC: process.env.COMSPEC, TEMP: root, TMP: root,
      HOME: root, USERPROFILE: root, APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'), XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_MODELS_FETCH: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1' }
    child = spawnContained(process.env.PAC_OPENCODE_BINARY, ['run', '--format', 'json', '-m', 'pacprobe/synthetic', 'Say hello'],
      { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let output = ''
    let errors = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { errors += chunk })
    const [code] = await once(child, 'close')
    assert.equal(code, 0, errors.slice(-3000))
    assert.equal(requestBody?.model, 'synthetic')
    assert.match(output, /PAC local probe response/)
  } finally {
    if (child && child.exitCode === null) stopContained(child)
    await new Promise((resolve) => server.close(resolve))
    const actual = await realpath(root)
    const local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-opencode-provider-')) await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
