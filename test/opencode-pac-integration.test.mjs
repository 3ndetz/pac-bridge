import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { attachAcpRelay } from '../src/acp-relay.mjs'
import { startAgent } from '../src/acp-transport.mjs'
import { openOpencodeAcpSession } from '../src/opencode-acp-session.mjs'
import { createOpencodeSessionRouter } from '../src/opencode-session-router.mjs'
import { createOpencodeProvider } from '../src/opencode-provider.mjs'
import { spawnContained, stopContained } from '../src/spawn-contained.mjs'

test('routes an actual OpenCode CLI text turn to a fake PAC', {
  skip: !process.env.PAC_OPENCODE_BINARY, timeout: 90000
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-opencode-integration-'))
  const relayServer = createServer()
  const relay = attachAcpRelay(relayServer, { authorize: () => true })
  let agent, provider, child, router
  const stages = []
  const token = 'local-test-token-with-at-least-32-characters'
  try {
    relayServer.listen(0, '127.0.0.1')
    await once(relayServer, 'listening')
    const url = `ws://127.0.0.1:${relayServer.address().port}`
    const fake = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))
    const acpRouter = fileURLToPath(new URL('../adapters/pac-opencode-router.mjs', import.meta.url))
    const plugin = new URL('../adapters/opencode-plugin.mjs', import.meta.url).href
    agent = await startAgent({ url, name: 'testpac', token: 'test-token', command: process.execPath, args: [fake, '--text-response'] })
    const tokenFile = join(root, 'token')
    await writeFile(tokenFile, 'test-token')
    const env = { PATH: process.env.PATH, PATHEXT: process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD',
      SystemRoot: process.env.SystemRoot, COMSPEC: process.env.COMSPEC, TEMP: root, TMP: root,
      HOME: root, USERPROFILE: root, APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'),
      XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
      OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1' }
    router = createOpencodeSessionRouter({ openSession: ({ model, cwd }) => { stages.push('open-acp'); return openOpencodeAcpSession({ command: process.execPath,
      args: [acpRouter, fake, '--native'], cwd, model, onPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      env: { ...env, PAC_EXPERIMENTAL: '1', PAC_OPENCODE_BINARY: process.execPath, PAC_RELAY_URL: url,
        PAC_NAME: 'testpac', PAC_SOURCE_TOKEN_FILE: tokenFile, PAC_CONTROLLER_CWD: root } }).then((session) => { stages.push('open-ok'); return session }, (error) => { stages.push(`open-error:${error.message}`); throw error }) } })
    provider = createOpencodeProvider({ token, cwd: root, router })
    provider.on('request', (request, response) => {
      let data = ''
      request.on('data', (chunk) => { data += chunk })
      request.on('end', () => { try { const body = JSON.parse(data); stages.push(`body:${body.messages?.at(-1)?.role}:${body.tools?.length || 0}`) } catch {} })
      response.on('close', () => stages.push(`status:${response.statusCode}`))
    })
    provider.listen(0, '127.0.0.1')
    await once(provider, 'listening')
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ plugin: [plugin], provider: { pacbridge: { npm: '@ai-sdk/openai-compatible', name: 'PAC',
      options: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: token },
      models: { 'PAC_testpac/sonnet': { name: 'testpac Sonnet' } } } } })
    child = spawnContained(process.env.PAC_OPENCODE_BINARY, ['run', '--format', 'json', '-m', 'pacbridge/PAC_testpac/sonnet', 'Hello PAC'],
      { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let output = '', errors = ''
    const deadline = setTimeout(() => stopContained(child), 50000)
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { errors += chunk })
    const [code] = await once(child, 'close')
    clearTimeout(deadline)
    assert.equal(code, 0, `${stages.join(',')}\n${errors.slice(-2000)}\n${output.slice(-2000)}`)
    assert.match(output, /fake PAC sonnet response/)
  } finally {
    if (child && child.exitCode === null) stopContained(child)
    router?.close()
    if (provider) await new Promise((resolve) => provider.close(resolve))
    agent?.close()
    relay.close()
    relayServer.close()
    const actual = await realpath(root)
    const local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-opencode-integration-')) await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
