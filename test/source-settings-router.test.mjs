import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { attachAcpRelay } from '../src/acp-relay.mjs'
import { startAgent } from '../src/acp-transport.mjs'
import { openOpencodeAcpSession } from '../src/opencode-acp-session.mjs'

test('rejects older controllers and changed source Claude settings or unsupported hooks', { timeout: 150000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-settings-router-'))
  const server = createServer(), relay = attachAcpRelay(server, { authorize: () => true })
  let agent, session
  const diagnostics = []
  try {
    await mkdir(join(root, '.claude'))
    const config = join(root, '.claude', 'settings.json')
    await writeFile(config, JSON.stringify({ effortLevel: 'high' }))
    await writeFile(join(root, 'token'), 'synthetic-test-token')
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const url = `ws://127.0.0.1:${server.address().port}`
    const fake = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))
    const router = fileURLToPath(new URL('../adapters/pac-opencode-router.mjs', import.meta.url))
    agent = await startAgent({ url, name: 'testpac', token: 'synthetic-test-token', command: process.execPath, args: [fake, '--prompt-hook'] })
    const openSession = () => openOpencodeAcpSession({ command: process.execPath, args: [router, fake, '--native'], cwd: root,
      env: { ...process.env, HOME: root, USERPROFILE: root, PAC_EXPERIMENTAL: '1', PAC_EXPERIMENTAL_HOOKS: '1', PAC_SOURCE_BASH: process.execPath,
        PAC_DIAGNOSTICS: '1', PAC_TEST_ASYNC_HOOKS: '1', PAC_TEST_SYNTHETIC_LIFECYCLE: '0', PAC_TEST_SYNTHETIC_SETTINGS: '0', PAC_OPENCODE_BINARY: process.execPath, PAC_RELAY_URL: url, PAC_NAME: 'testpac', PAC_SOURCE_TOKEN_FILE: join(root, 'token'), PAC_CONTROLLER_CWD: root },
      model: 'PAC_testpac/sonnet', onDiagnostic: value => diagnostics.push(value), onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })
    session = await openSession()
    await assert.rejects(session.prompt([{ type: 'text', text: 'hello' }], () => {}), /does not support source Claude settings/)
    assert.ok(diagnostics.includes('prompt_failure:settings_unsupported'))
    await writeFile(config, JSON.stringify({ effortLevel: 'low' }))
    await assert.rejects(session.prompt([{ type: 'text', text: 'hello' }], () => {}), /settings changed/)
    assert.ok(diagnostics.includes('prompt_failure:settings_changed'))
    session.close()
    await writeFile(config, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: process.execPath, args: ['-e', 'process.exit(0)'], async: true }] }] } }))
    session = await openSession()
    await assert.rejects(session.prompt([{ type: 'text', text: 'hello' }], () => {}), /does not support async source hooks/)
    for (const event of ['Stop', 'Notification']) {
      session.close()
      await writeFile(config, JSON.stringify({ hooks: { [event]: [{ hooks: [{ type: 'command', command: process.execPath, args: ['-e', 'process.exit(0)'] }] }] } }))
      session = await openSession()
      await assert.rejects(session.prompt([{ type: 'text', text: 'hello' }], () => {}), /cannot safely forward source Stop or Notification hooks/)
    }
  } finally {
    session?.close(); agent?.close(); relay.close(); server.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
