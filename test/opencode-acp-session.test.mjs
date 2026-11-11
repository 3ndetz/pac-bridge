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

test('retains an idle subagent update for its originating session', { timeout: 15000 }, async () => {
  const fake = fileURLToPath(new URL('./fixtures/fake-opencode-child-events.mjs', import.meta.url))
  const session = await openOpencodeAcpSession({ command: process.execPath, args: [fake], cwd: tmpdir(), env: process.env,
    model: 'PAC_test/sonnet', onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })
  try {
    const first = [], second = []
    await session.prompt([], (event) => first.push(event))
    await new Promise((resolve) => setTimeout(resolve, 300))
    await session.prompt([], (event) => second.push(event))
    assert.equal(first.find((event) => event.method === 'opencode/session/child_update')?.params.status, 'created')
    assert.equal(second.find((event) => event.method === 'opencode/session/child_update')?.params.status, 'completed')
  } finally { session.close() }
})

test('rejects a child event attributed to another root session', { timeout: 15000 }, async () => {
  const fake = fileURLToPath(new URL('./fixtures/fake-opencode-child-events.mjs', import.meta.url))
  const session = await openOpencodeAcpSession({ command: process.execPath, args: [fake], cwd: tmpdir(),
    env: { ...process.env, PAC_TEST_BAD_CHILD_OWNER: '1' }, model: 'PAC_test/sonnet', onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })
  try { await assert.rejects(session.prompt([], () => {}), /connection lost/) } finally { session.close() }
})

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
    agent = await startAgent({ url, name: 'testpac', token: 'test-token', command: process.execPath, args: [fake, '--background-task'] })
    const tokenFile = join(root, 'token')
    await writeFile(tokenFile, 'test-token')
    await mkdir(join(root, 'workspace'))
    const discovered = await discoverOpencodePacs({ command: process.execPath, args: [router, fake, '--native'], cwd: join(root, 'workspace'),
      env: { ...process.env, PAC_EXPERIMENTAL: '1', PAC_OPENCODE_BINARY: process.execPath, PAC_RELAY_URL: url,
        PAC_NAME: 'testpac', PAC_DISPLAY_NAME: '#1', PAC_MODEL_PREFIX: 'Claude', PAC_SOURCE_TOKEN_FILE: tokenFile, PAC_CONTROLLER_CWD: root } })
    assert.ok(discovered.models.some((model) => model.id === 'PAC_testpac/sonnet'))
    assert.equal(discovered.models.find((model) => model.id === 'PAC_testpac/sonnet')?.name, 'PAC #1 / Claude Sonnet')
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
    await writeFile(endpoints, JSON.stringify([{ id: 'testpac', name: 'testpac', displayName: '#1', modelPrefix: 'Claude', url, tokenFile, cwd: root }]))
    const labeled = await discoverPacsDirect({ cwd: join(root, 'workspace'), env: { PAC_ENDPOINTS_FILE: endpoints } })
    assert.equal(labeled.models.find((model) => model.id === 'PAC_testpac/sonnet')?.name, 'PAC #1 / Claude Sonnet')
    await writeFile(endpoints, JSON.stringify([{ id: 'a', name: 'a', displayName: '#1', url, tokenFile, cwd: root }, { id: 'b', name: 'b', displayName: '#1', url, tokenFile, cwd: root }]))
    await assert.rejects(discoverPacsDirect({ cwd: join(root, 'workspace'), env: { PAC_ENDPOINTS_FILE: endpoints } }), /duplicate/)
    session = await openOpencodeAcpSession({ command: process.execPath, args: [router, fake, '--native'], cwd: join(root, 'workspace'),
      env: { ...process.env, PAC_EXPERIMENTAL: '1', PAC_OPENCODE_BINARY: process.execPath, PAC_RELAY_URL: url,
        PAC_NAME: 'testpac', PAC_SOURCE_TOKEN_FILE: tokenFile, PAC_CONTROLLER_CWD: root },
      model: 'PAC_testpac/sonnet', onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })
    const events = []
    assert.deepEqual(await session.prompt([], (event) => events.push(event)), { stopReason: 'end_turn' })
    const taskId = events.find((event) => event.method === 'pac/background_tasks_changed')?.params.tasks[0]?.task_id
    assert.equal(taskId, 'testpac:child-1')
    assert.equal((await session.stopTask(taskId)).status, 'stop_requested')
    await assert.rejects(session.stopTask('other:child-1'), /Unknown or inactive/)
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
