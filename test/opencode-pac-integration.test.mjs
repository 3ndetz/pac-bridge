import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
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

test('experimental launcher sends a text turn to authenticated Claude', {
  skip: !process.env.PAC_LIVE_URL || !process.env.PAC_LIVE_SOURCE_TOKEN_FILE || !process.env.PAC_OPENCODE_BINARY, timeout: 180000
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-opencode-live-'))
  let child
  try {
    const toolTest = process.env.PAC_LIVE_TOOL_TEST === '1'
    const denyTest = process.env.PAC_LIVE_DENY_TEST === '1'
    const writeTest = process.env.PAC_LIVE_WRITE_TEST === '1' || denyTest
    const fixture = join(root, 'source-fixture.txt')
    if (toolTest) await writeFile(fixture, 'PAC_READ_FIXTURE_CONTENT')
    const launcher = fileURLToPath(new URL('../adapters/opencode-pac.mjs', import.meta.url))
    const env = { PATH: process.env.PATH, PATHEXT: process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD',
      SystemRoot: process.env.SystemRoot, COMSPEC: process.env.COMSPEC, TEMP: root, TMP: root,
      HOME: root, USERPROFILE: root, APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'),
      XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
      OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS, PAC_EXPERIMENTAL: '1', PAC_DIAGNOSTICS: '1',
      PAC_EXPERIMENTAL_HOOKS: '1', PAC_SOURCE_BASH: join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
      PAC_OPENCODE_BINARY: process.env.PAC_OPENCODE_BINARY, PAC_MODEL: 'PAC_testpac/sonnet',
      PAC_RELAY_URL: process.env.PAC_LIVE_URL, PAC_NAME: 'testpac', PAC_SOURCE_TOKEN_FILE: process.env.PAC_LIVE_SOURCE_TOKEN_FILE,
      PAC_CONTROLLER_CWD: process.env.PAC_LIVE_CONTROLLER_CWD }
    if (denyTest) env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ permission: { pac_bridge: 'deny' } })
    const prompt = writeTest
      ? `Use Write to create the local file ${fixture} containing exactly PAC_WRITE_FIXTURE_CONTENT. Then say PAC_WRITE_VERIFIED.`
      : toolTest
      ? `Read the local file ${fixture}. If it contains PAC_READ_FIXTURE_CONTENT, finish your response with PAC_READ_VERIFIED.`
      : 'Reply exactly PAC_CLI_LIVE_OK. Do not use tools.'
    child = spawnContained(process.execPath, [launcher, 'run', '--format', 'json', ...(writeTest ? ['--auto'] : []), prompt],
      { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let output = '', errors = ''
    const deadline = setTimeout(() => stopContained(child), 150000)
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { errors += chunk })
    const [code] = await once(child, 'close')
    clearTimeout(deadline)
    const categories = errors.split(/\r?\n/).filter((line) => /^PAC (?:provider failure: |ACP (?:notification:)?)[a-zA-Z_ ()-]+$/.test(line)).join(', ')
    assert.equal(code, 0, `OpenCode live probe failed: ${categories || 'no diagnostic category'}`)
    if (!denyTest) assert.match(output, writeTest ? /PAC_WRITE_VERIFIED/ : toolTest ? /PAC_READ_VERIFIED/ : /PAC_CLI_LIVE_OK/)
    if (toolTest || writeTest) assert.match(output, /PAC tool event/)
    if (writeTest) {
      let content
      try { content = await readFile(fixture, 'utf8') } catch {}
      const observed = { approvalTool: output.includes('pac_approval'), permissionDenied: /permission.*(?:denied|reject)/i.test(output),
        errorEvent: output.includes('"type":"error"'), categories }
      assert.equal(observed.approvalTool, true, `Live write did not request approval: ${JSON.stringify(observed)}`)
      if (denyTest) assert.equal(content, undefined, 'Denied write changed the source')
      else assert.equal(content?.trim(), 'PAC_WRITE_FIXTURE_CONTENT', `Live write did not reach the source: ${JSON.stringify(observed)}`)
    }
  } finally {
    if (child && child.exitCode === null) stopContained(child)
    const actual = await realpath(root)
    const local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-opencode-live-')) await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

test('experimental launcher opens OpenCode against a fake PAC', {
  skip: !process.env.PAC_OPENCODE_BINARY, timeout: 120000
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-opencode-launcher-'))
  const relayServer = createServer()
  const relay = attachAcpRelay(relayServer, { authorize: () => true })
  let agent, child
  try {
    relayServer.listen(0, '127.0.0.1')
    await once(relayServer, 'listening')
    const url = `ws://127.0.0.1:${relayServer.address().port}`
    const fake = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))
    const launcher = fileURLToPath(new URL('../adapters/opencode-pac.mjs', import.meta.url))
    const permissionTest = process.env.PAC_TEST_PERMISSION === '1'
    const denyTest = process.env.PAC_TEST_DENY === '1'
    agent = await startAgent({ url, name: 'testpac', token: 'test-token', command: process.execPath, args: [fake, permissionTest ? '--permission-response' : '--text-response'] })
    const tokenFile = join(root, 'token')
    await writeFile(tokenFile, 'test-token')
    const env = { PATH: process.env.PATH, PATHEXT: process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD',
      SystemRoot: process.env.SystemRoot, COMSPEC: process.env.COMSPEC, TEMP: root, TMP: root,
      HOME: root, USERPROFILE: root, APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'),
      XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
      OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      PAC_EXPERIMENTAL: '1', PAC_DIAGNOSTICS: '1', PAC_OPENCODE_BINARY: process.env.PAC_OPENCODE_BINARY, PAC_MODEL: 'PAC_testpac/sonnet',
      PAC_RELAY_URL: url, PAC_NAME: 'testpac', PAC_SOURCE_TOKEN_FILE: tokenFile, PAC_CONTROLLER_CWD: root }
    if (denyTest) env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ permission: { pac_bridge: 'deny' } })
    child = spawnContained(process.execPath, [launcher, 'run', '--format', 'json', ...(permissionTest ? ['--auto'] : []), 'Hello PAC'],
      { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let output = '', errors = ''
    const deadline = setTimeout(() => stopContained(child), 90000)
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { errors += chunk })
    const [code] = await once(child, 'close')
    clearTimeout(deadline)
    assert.equal(code, 0, `${errors.slice(-2000)}\n${output.slice(-2000)}`)
    assert.match(output, permissionTest ? (denyTest ? /fake PAC permission deny/ : /fake PAC permission allow/) : /fake PAC sonnet response/)
  } finally {
    if (child && child.exitCode === null) stopContained(child)
    agent?.close()
    relay.close()
    relayServer.close()
    const actual = await realpath(root)
    const local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-opencode-launcher-')) await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
