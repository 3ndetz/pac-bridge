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

test('OpenCode ignores changing Claude settings and still enforces native OpenCode policy', { timeout: 150000 }, async () => {
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
    agent = await startAgent({ url, name: 'testpac', token: 'synthetic-test-token', command: process.execPath, args: [fake, '--text-response'] })
    const openSession = () => openOpencodeAcpSession({ command: process.execPath, args: [router, fake, '--native'], cwd: root,
      env: { ...process.env, HOME: root, USERPROFILE: root, PAC_EXPERIMENTAL: '1', PAC_EXPERIMENTAL_HOOKS: '1', PAC_SOURCE_BASH: process.execPath,
        OPENCODE_CONFIG:'', OPENCODE_CONFIG_CONTENT:'', OPENCODE_CONFIG_DIR:'', XDG_CONFIG_HOME:join(root,'.config'), PAC_DIAGNOSTICS: '1', PAC_TEST_ASYNC_HOOKS: '1', PAC_TEST_SYNTHETIC_LIFECYCLE: '0', PAC_TEST_SYNTHETIC_SETTINGS: '0', PAC_OPENCODE_BINARY: process.execPath, PAC_RELAY_URL: url, PAC_NAME: 'testpac', PAC_SOURCE_TOKEN_FILE: join(root, 'token'), PAC_CONTROLLER_CWD: root },
      model: 'PAC_testpac/sonnet', onDiagnostic: value => diagnostics.push(value), onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })
    session = await openSession()
    for (const settings of [{effortLevel:'high'}, {effortLevel:'low'}, {env:{HTTPS_PROXY:'http://synthetic.invalid:9999'}}, {hooks:{Stop:[{hooks:[{type:'command',command:'DO_NOT_EXECUTE_SYNTHETIC_HOOK'}]}]}}]) {
      await writeFile(config,JSON.stringify(settings))
      assert.equal((await session.prompt([{type:'text',text:'hello'}],()=>{})).stopReason,'end_turn')
    }
    await writeFile(config,'{INVALID_LOCAL_CLAUDE_SETTINGS')
    assert.equal((await session.prompt([{type:'text',text:'hello'}],()=>{})).stopReason,'end_turn')
    const nativeConfig=join(root,'opencode.json')
    await writeFile(nativeConfig,JSON.stringify({permission:{read:'deny'}}))
    await assert.rejects(session.prompt([{type:'text',text:'hello'}],()=>{}),/OpenCode permission configuration is not yet supported/)
    await writeFile(nativeConfig,JSON.stringify({plugin:['synthetic-do-not-execute']}))
    await assert.rejects(session.prompt([{type:'text',text:'hello'}],()=>{}),/Configured OpenCode plugins and hooks are not yet supported/)
    await writeFile(nativeConfig,'{}')
    assert.equal((await session.prompt([{type:'text',text:'hello'}],()=>{})).stopReason,'end_turn')
  } finally {
    session?.close(); await agent?.close(); relay.close(); server.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
