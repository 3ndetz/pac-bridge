import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { Duplex } from 'node:stream'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { attachAcpRelay } from '../src/acp-relay.mjs'
import { createAcpPeer } from '../src/acp-peer.mjs'
import { spawnContained, stopContained } from '../src/spawn-contained.mjs'

const exec = promisify(execFile)
const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))

test('installed POSIX launcher exposes PAC and preserves native models when its PAC files are unavailable',
  { skip: process.platform === 'win32' || !process.env.PAC_OPENCODE_BINARY, timeout: 240000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'pac-posix-acp-')), keys = join(root, 'keys'), home = join(root, 'home')
    let relay, server, agent
    const children = []
    try {
      await mkdir(keys); await mkdir(home)
      const cert = join(keys, 'pac-relay-ca.pem'), key = join(root, 'relay-key.pem'), token = join(keys, 'pac-source-token.txt')
      await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1',
        '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'])
      await writeFile(token, 'synthetic-token')
      server = createServer({ key: await readFile(key), cert: await readFile(cert) })
      relay = attachAcpRelay(server, { authorize: () => true })
      server.listen(0, '127.0.0.1'); await once(server, 'listening')
      const url = `wss://127.0.0.1:${server.address().port}`
      await writeFile(join(keys, 'connection.json'), JSON.stringify({ relayUrl: url, pacName: 'testpac', controllerCwd: root }))
      const fake = join(rootDir, 'test', 'fixtures', 'fake-acp-agent.mjs')
      agent = spawnContained(process.execPath, [join(rootDir, 'adapters', 'pac-acp-agent.mjs'), 'testpac', url, token, process.execPath, fake, '--text-response'],
        { cwd: root, env: { ...process.env, NODE_EXTRA_CA_CERTS: cert }, stdio: ['ignore', 'ignore', 'ignore'] })
      agent.on('error', () => {})
      await new Promise(resolve => setTimeout(resolve, 1000))
      const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'),
        XDG_CACHE_HOME: join(home, 'cache'), XDG_STATE_HOME: join(home, 'state'), OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_DISABLE_PROJECT_CONFIG: '1', PAC_SOURCE_BASH: '/bin/bash', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: rootDir,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { native_test: { npm: '@ai-sdk/openai-compatible', name: 'Native test',
          options: { baseURL: 'http://127.0.0.1:1/v1', apiKey: 'test' }, models: { 'native-model': { name: 'Native model' } } } } }) }
      delete env.NODE_EXTRA_CA_CERTS
      await exec('sh', [join(rootDir, 'scripts', 'install-posix.sh'), keys, process.env.PAC_OPENCODE_BINARY], { cwd: rootDir, env, timeout: 120000 })
      const launcher = join(home, '.local', 'share', 'pac-bridge', 'bin', 'opencode')
      async function open(probe) {
        const child = spawnContained(launcher, ['acp'], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] })
        children.push(child); child.stderr.resume(); child.on('error', () => {})
        const updates = []
        const peer = createAcpPeer(Duplex.from({ readable: child.stdout, writable: child.stdin }), { onNotification(method, params) { updates.push({ method, params }) }, onRequest: async () => ({}) })
        await peer.call('initialize', { protocolVersion: 1, clientCapabilities: {}, ...(probe ? { clientInfo: { name: 'hapi-opencode-models', version: '0.34.4' } } : {}) }, 60000)
        const session = await peer.call('session/new', { cwd: root, mcpServers: [] }, 90000)
        return { peer, session, updates }
      }
      const initial = await open(false)
      const options = initial.session.configOptions?.find(item => item.category === 'model')?.options || []
      assert.ok(options.some(item => item.value === 'PAC_testpac/sonnet'))
      await initial.peer.call('session/set_config_option', { sessionId: initial.session.sessionId, configId: 'model', value: 'PAC_testpac/sonnet' }, 30000)
      assert.equal((await initial.peer.call('session/prompt', { sessionId: initial.session.sessionId, prompt: [{ type: 'text', text: 'Hello PAC' }] }, 90000)).stopReason, 'end_turn')
      assert.match(JSON.stringify(initial.updates), /fake PAC sonnet response/)
      initial.peer.close()
      await unlink(token)
      const fallback = await open(true)
      const models = fallback.session.models?.availableModels || fallback.session.configOptions?.find(item => item.category === 'model')?.options || []
      assert.ok(models.some(item => (item.modelId || item.value) === 'native_test/native-model'))
      assert.ok(!models.some(item => String(item.modelId || item.value).includes('PAC_testpac')))
      fallback.peer.close()
    } finally {
      for (const child of children) if (child.exitCode === null) try { stopContained(child) } catch {}
      if (agent && agent.exitCode === null) try { stopContained(agent) } catch {}
      relay?.close(); server?.close()
      const actual = await realpath(root), local = relative(await realpath(tmpdir()), actual)
      if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-posix-acp-')) await rm(actual, { recursive: true, force: true })
    }
  })
