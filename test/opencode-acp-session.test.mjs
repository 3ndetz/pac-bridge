import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { attachAcpRelay } from '../src/acp-relay.mjs'
import { startAgent } from '../src/acp-transport.mjs'
import { openOpencodeAcpSession } from '../src/opencode-acp-session.mjs'
import { discoverOpencodePacs } from '../src/opencode-discovery.mjs'
import { discoverPacsDirect } from '../src/pac-direct-discovery.mjs'

test('opens a selected PAC through the OpenCode ACP router', { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-opencode-acp-'))
  const server = createServer()
  const relay = attachAcpRelay(server, { authorize: () => true })
  let agent, session
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const url = `ws://127.0.0.1:${server.address().port}`
    const fake = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))
    const router = fileURLToPath(new URL('../adapters/pac-opencode-router.mjs', import.meta.url))
    agent = await startAgent({ url, name: 'testpac', token: 'test-token', command: process.execPath, args: [fake] })
    const tokenFile = join(root, 'token')
    await writeFile(tokenFile, 'test-token')
    await mkdir(join(root, 'workspace'))
    const discovered = await discoverOpencodePacs({ command: process.execPath, args: [router, fake, '--native'], cwd: join(root, 'workspace'),
      env: { ...process.env, PAC_EXPERIMENTAL: '1', PAC_OPENCODE_BINARY: process.execPath, PAC_RELAY_URL: url,
        PAC_NAME: 'testpac', PAC_SOURCE_TOKEN_FILE: tokenFile, PAC_CONTROLLER_CWD: root } })
    assert.ok(discovered.models.some((model) => model.id === 'PAC_testpac/sonnet'))
    assert.deepEqual(discovered.warnings, [])
    const endpoints = join(root, 'endpoints.json')
    await writeFile(endpoints, JSON.stringify(['testpac', 'offline'].map((name) => ({ id: name, name, url, tokenFile, cwd: root }))))
    const partial = await discoverOpencodePacs({ command: process.execPath, args: [router, fake, '--native'], cwd: join(root, 'workspace'),
      env: { ...process.env, PAC_EXPERIMENTAL: '1', PAC_OPENCODE_BINARY: process.execPath, PAC_ENDPOINTS_FILE: endpoints } })
    assert.ok(partial.models.some((model) => model.id === 'PAC_testpac/sonnet'))
    assert.ok(!partial.models.some((model) => model.id.startsWith('PAC_offline/')))
    assert.deepEqual(partial.warnings, [{ name: 'offline', code: 'unavailable' }])
    const direct = await discoverPacsDirect({ cwd: join(root, 'workspace'), env: { PAC_ENDPOINTS_FILE: endpoints } })
    assert.ok(direct.models.some((model) => model.id === 'PAC_testpac/sonnet'))
    assert.deepEqual(direct.warnings, [{ name: 'offline', code: 'unavailable' }])
    session = await openOpencodeAcpSession({ command: process.execPath, args: [router, fake, '--native'], cwd: join(root, 'workspace'),
      env: { ...process.env, PAC_EXPERIMENTAL: '1', PAC_OPENCODE_BINARY: process.execPath, PAC_RELAY_URL: url,
        PAC_NAME: 'testpac', PAC_SOURCE_TOKEN_FILE: tokenFile, PAC_CONTROLLER_CWD: root },
      model: 'PAC_testpac/sonnet', onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })
    assert.deepEqual(await session.prompt([], () => {}), { selected: 'sonnet' })
  } finally {
    session?.close()
    agent?.close()
    relay.close()
    server.close()
    const actual = await realpath(root)
    const local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-opencode-acp-')) await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
