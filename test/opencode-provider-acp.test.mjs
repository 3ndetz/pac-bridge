import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { Duplex } from 'node:stream'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { attachAcpRelay } from '../src/acp-relay.mjs'
import { startAgent } from '../src/acp-transport.mjs'
import { createAcpPeer } from '../src/acp-peer.mjs'
import { spawnContained, stopContained } from '../src/spawn-contained.mjs'

test('HAPI model probe keeps native models and checks the requested workspace', { skip: !process.env.PAC_OPENCODE_BINARY, timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-model-probe-'))
  const server = createServer(), relay = attachAcpRelay(server, { authorize: () => true })
  let agent
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const url = `ws://127.0.0.1:${server.address().port}`
    const fake = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))
    agent = await startAgent({ url, name: 'testpac', token: 'test-token', command: process.execPath, args: [fake, '--text-response'] })
    const tokenFile = join(root, 'token'), allowed = join(root, 'allowed'), rejected = join(root, 'rejected')
    await writeFile(tokenFile, 'test-token')
    await mkdir(allowed); await mkdir(join(rejected, '.claude'), { recursive: true })
    await writeFile(join(rejected, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Read'] } }))
    const launcher = fileURLToPath(new URL('../adapters/pac-hapi-opencode.mjs', import.meta.url))
    const env = { ...process.env, OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { native_test: { npm: '@ai-sdk/openai-compatible', name: 'Native test', options: { baseURL: 'http://127.0.0.1:1/v1', apiKey: 'test' }, models: { 'native-model': { name: 'Native model' } } } } }),
      PAC_EXPERIMENTAL: '1', PAC_HAPI_PROVIDER_EXPERIMENT: '1', PAC_NAMED_PROVIDERS_EXPERIMENT: '1', PAC_RELAY_URL: url, PAC_NAME: 'testpac', PAC_DISPLAY_NAME: '#1', PAC_MODEL_PREFIX: 'Claude', PAC_SOURCE_TOKEN_FILE: tokenFile,
      PAC_CONTROLLER_CWD: root, PAC_SOURCE_BASH: process.env.PAC_SOURCE_BASH }
    for (const [cwd, expectPac, offline] of [[allowed, true, false], [rejected, false, false], [allowed, false, true]]) {
      const child = spawnContained(process.execPath, [launcher, 'acp'], { cwd: root, env: offline ? { ...env, PAC_RELAY_URL: 'ws://127.0.0.1:1' } : env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      child.stderr.resume()
      const peer = createAcpPeer(Duplex.from({ readable: child.stdout, writable: child.stdin }), { onNotification() {}, onRequest: async () => ({}) })
      try {
        await peer.call('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'hapi-opencode-models', version: '0.34.4' } }, 30000)
        const response = await peer.call('session/new', { cwd, mcpServers: [] }, 30000)
        const models = response.models?.availableModels || []
        assert.ok(models.some((item) => item.modelId === 'native_test/native-model'), 'native provider remains available')
        assert.equal(models.some((item) => item.modelId === 'PAC_testpac/sonnet'), expectPac)
      } finally { peer.close(); if (child.exitCode === null) try { stopContained(child) } catch {} }
    }
  } finally {
    agent?.close(); relay.close(); server.close()
    const actual = await realpath(root), local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-model-probe-')) await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

test('unmodified OpenCode ACP exposes PAC provider models without preselection', { skip: !process.env.PAC_OPENCODE_BINARY, timeout: 180000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-provider-acp-'))
  const relayServer = createServer()
  const relay = attachAcpRelay(relayServer, { authorize: () => true })
  let agent, child
  try {
    relayServer.listen(0, '127.0.0.1')
    await once(relayServer, 'listening')
    const url = `ws://127.0.0.1:${relayServer.address().port}`
    const fake = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))
    agent = await startAgent({ url, name: 'testpac', token: 'test-token', command: process.execPath, args: [fake, '--text-response', '--nested-model'] })
    const tokenFile = join(root, 'token')
    await writeFile(tokenFile, 'test-token')
    // HAPI V1 supplies --cwd but its ACP child inherits the runner's cwd.
    // Deny PAC in that inherited directory so this test catches discovery
    // accidentally using it instead of the requested project.
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    await mkdir(join(root, '.claude'))
    await writeFile(join(root, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Read'] } }))
    const launcher = fileURLToPath(new URL('../adapters/pac-hapi-opencode.mjs', import.meta.url))
    const env = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'),
      XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
      OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      PAC_EXPERIMENTAL: '1', PAC_HAPI_PROVIDER_EXPERIMENT: '1', PAC_NAMED_PROVIDERS_EXPERIMENT: '1', PAC_RELAY_URL: url, PAC_NAME: 'testpac', PAC_SOURCE_TOKEN_FILE: tokenFile,
      PAC_CONTROLLER_CWD: root, PAC_SESSION_DIR: join(root, 'sessions'), PAC_SOURCE_BASH: process.env.PAC_SOURCE_BASH,
      PAC_DISPLAY_NAME: '#1', PAC_MODEL_PREFIX: 'Claude' }
    delete env.PAC_MODEL
    child = spawnContained(process.execPath, [launcher, 'acp', '--cwd', workspace], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let errors = ''
    child.stderr.on('data', chunk => { errors += chunk })
    const updates = []
    const peer = createAcpPeer(Duplex.from({ readable: child.stdout, writable: child.stdin }), { onNotification(method, params) { updates.push({ method, params }) }, onRequest: async () => ({}) })
    await peer.call('initialize', { protocolVersion: 1, clientCapabilities: {} }, 60000).catch(error => { throw new Error(`${error.message}: ${errors.slice(-2000)}`) })
    const session = await peer.call('session/new', { cwd: workspace, mcpServers: [] }, 90000)
    const models = session.models?.availableModels || session.configOptions?.find(item => item.category === 'model')?.options || []
    assert.ok(models.some(item => String(item.modelId || item.value).includes('PAC_testpac')), `${JSON.stringify(models).slice(0, 1000)} ${errors.slice(-1000)}`)
    const option = session.configOptions?.find(item => item.category === 'model')
    const selected = option?.options?.find(item => String(item.value).endsWith('PAC_testpac/sonnet'))
    assert.ok(option && selected, 'PAC model must be selectable through standard ACP')
    assert.equal(selected.value, 'PAC_testpac/sonnet')
    await peer.call('session/set_config_option', { sessionId: session.sessionId, configId: option.id, value: selected.value }, 30000)
    const response = await peer.call('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Hello PAC' }] }, 90000)
    assert.equal(response.stopReason, 'end_turn')
    assert.match(JSON.stringify(updates.filter(item => item.params?.update?.sessionUpdate === 'agent_message_chunk')), /fake PAC sonnet response/)
    const nested = option.options.find(item => item.value === 'PAC_testpac/openai/gpt-5-codex')
    assert.ok(nested, 'A PAC model with a provider-qualified ID must be available')
    assert.match(nested.name, /^PAC #1\s*\/\s*Codex$/)
    await peer.call('session/set_config_option', { sessionId: session.sessionId, configId: option.id, value: nested.value }, 30000)
    const codex = await peer.call('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Hello Codex' }] }, 90000)
    assert.equal(codex.stopReason, 'end_turn')
    assert.match(JSON.stringify(updates.filter(item => item.params?.update?.sessionUpdate === 'agent_message_chunk')), /fake PAC openai\/gpt-5-codex response/)
  } finally {
    if (child && child.exitCode === null) { try { stopContained(child) } catch {} }
    agent?.close()
    relay.close()
    relayServer.close()
  }
})

test('unavailable PAC leaves native OpenCode providers usable', { skip: !process.env.PAC_OPENCODE_BINARY, timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-offline-acp-'))
  const tokenFile = join(root, 'token')
  await writeFile(tokenFile, 'test-token')
  const launcher = fileURLToPath(new URL('../adapters/pac-hapi-opencode.mjs', import.meta.url))
  const env = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'),
    XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
    OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { native_test: { npm: '@ai-sdk/openai-compatible', name: 'Native test', options: { baseURL: 'http://127.0.0.1:1/v1', apiKey: 'test' }, models: { 'native-model': { name: 'Native model' } } } } }),
    PAC_EXPERIMENTAL: '1', PAC_HAPI_PROVIDER_EXPERIMENT: '1', PAC_NAMED_PROVIDERS_EXPERIMENT: '1', PAC_RELAY_URL: 'ws://127.0.0.1:1', PAC_NAME: 'testpac', PAC_SOURCE_TOKEN_FILE: tokenFile,
    PAC_CONTROLLER_CWD: root, PAC_SESSION_DIR: join(root, 'sessions'), PAC_SOURCE_BASH: process.env.PAC_SOURCE_BASH }
  delete env.PAC_MODEL
  const child = spawnContained(process.execPath, [launcher, 'acp'], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let errors = ''
  child.stderr.on('data', chunk => { errors += chunk })
  try {
    const peer = createAcpPeer(Duplex.from({ readable: child.stdout, writable: child.stdin }), { onNotification() {}, onRequest: async () => ({}) })
    await peer.call('initialize', { protocolVersion: 1, clientCapabilities: {} }, 60000).catch(error => { throw new Error(`${error.message}: ${errors.slice(-2000)}`) })
    const session = await peer.call('session/new', { cwd: root, mcpServers: [] }, 60000)
    const models = session.models?.availableModels || session.configOptions?.find(item => item.category === 'model')?.options || []
    assert.ok(models.some(item => String(item.modelId || item.value).includes('native_test/native-model')), JSON.stringify(models).slice(0, 1000))
    assert.ok(!models.some(item => String(item.modelId || item.value).includes('PAC_testpac')))
    assert.match(errors, /PAC testpac: unavailable/)
  } finally {
    if (child.exitCode === null) { try { stopContained(child) } catch {} }
  }
})
