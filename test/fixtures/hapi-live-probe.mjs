import { spawn, spawnSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { access, mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [relayUrl, tokenFile, remoteCwd] = process.argv.slice(2)
const hapi = process.env.PAC_TEST_HAPI
const hapiHub = process.env.PAC_TEST_HAPI_HUB || hapi
const opencode = process.env.PAC_TEST_OPENCODE
if (!hapi || !opencode) throw new Error('Test HAPI and OpenCode executables are required')
const root = await mkdtemp(join(tmpdir(), 'pac-hapi-proof-'))
const bin = join(root, 'bin')
const workspace = join(root, 'workspace')
await mkdir(bin)
await mkdir(workspace)
if (process.env.PAC_HAPI_INSTRUCTIONS === '1') {
  await mkdir(join(workspace, 'rules'))
  await mkdir(join(workspace, '.claude', 'rules'), { recursive: true })
  await writeFile(join(workspace, 'CLAUDE.md'), 'Source instructions: @rules/marker.md\n')
  await writeFile(join(workspace, 'rules', 'marker.md'), 'For the source instruction verification request, the exact marker is PAC_SOURCE_INSTRUCTION_483729.\n')
  await writeFile(join(workspace, '.claude', 'rules', 'marker.md'), 'For the source rule verification request, the exact marker is PAC_SOURCE_RULE_592174.\n')
}
if (process.env.PAC_HAPI_HOOKS === '1') {
  const config = join(workspace, '.claude')
  await mkdir(config, { recursive: true })
  const hookScript = 'let input="";process.stdin.on("data",x=>input+=x);process.stdin.on("end",()=>{const event=JSON.parse(input);const path=event.tool_input?.file_path||"";if(path.endsWith("hook-block.txt")||path.endsWith("hook-error.txt")){require("node:fs").writeFileSync(".claude/hook-observed.json",JSON.stringify({cwd:event.cwd,tool:event.tool_name}));process.stderr.write("blocked by source project hook");process.exitCode=path.endsWith("hook-error.txt")?1:2}})'
  const postScript = 'let input="";process.stdin.on("data",x=>input+=x);process.stdin.on("end",()=>{const event=JSON.parse(input);require("node:fs").writeFileSync(".claude/post-observed.json",JSON.stringify({cwd:event.cwd,tool:event.tool_name}))})'
  const failureScript = 'let input="";process.stdin.on("data",x=>input+=x);process.stdin.on("end",()=>{const event=JSON.parse(input);require("node:fs").writeFileSync(".claude/failure-observed.json",JSON.stringify({cwd:event.cwd,tool:event.tool_name,error:typeof event.error==="string"&&event.error.length>0}))})'
  await writeFile(join(config, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: '^Read$', hooks: [
    { type: 'command', command: process.execPath, args: ['-e', hookScript], timeout: 10 }
  ] }], PostToolUse: [{ matcher: '^Write$', hooks: [{ type: 'command', command: process.execPath, args: ['-e', postScript], timeout: 10 }] }],
    PostToolUseFailure: [{ matcher: '^Read$', hooks: [{ type: 'command', command: process.execPath, args: ['-e', failureScript], timeout: 10 }] }] } }))
}
if (process.env.PAC_HAPI_SKILLS === '1') {
  const skillDirectory = join(workspace, process.env.PAC_HAPI_OPENCODE_SKILLS === '1' ? '.opencode' : '.claude', 'skills', 'pac-test-skill')
  await mkdir(skillDirectory, { recursive: true })
  await writeFile(join(skillDirectory, 'SKILL.md'), '---\nname: pac-test-skill\ndescription: Return the PAC skill verification marker with its argument\n---\n\nReply exactly with PAC_SKILL_SUCCESS_$ARGUMENTS.\n')
}
if (process.env.PAC_HAPI_SCOPED === '1') {
  await mkdir(join(workspace, '.claude', 'rules'), { recursive: true })
  const largeContext = process.env.PAC_HAPI_LARGE_INSTRUCTIONS === '1' ? `${'Additional project guidance. '.repeat(850)}\n` : ''
  await writeFile(join(workspace, '.claude', 'rules', 'file-rule.md'), `---\npaths: "fixture.txt"\n---\n${largeContext}When asked for the scoped marker, reply with PAC_HAPI_SCOPED_492316.\n`)
}
const file = join(workspace, 'fixture.txt')
await writeFile(file, 'PAC_HAPI_INITIAL')
const router = fileURLToPath(new URL('../../adapters/pac-hapi-opencode.mjs', import.meta.url))
const launcher = `@echo off\r\nif /i "%~1"=="acp" (\r\n  "${process.execPath}" "${router}" %*\r\n) else (\r\n  "${opencode}" %*\r\n)\r\n`
await writeFile(join(bin, 'opencode.cmd'), launcher)
const reserved = createServer().listen(0, '127.0.0.1')
await new Promise((resolve) => reserved.once('listening', resolve))
const port = reserved.address().port
await new Promise((resolve) => reserved.close(resolve))
const url = `http://127.0.0.1:${port}`
const accessToken = randomBytes(32).toString('base64url')
const env = { ...process.env, CLI_API_TOKEN: accessToken, HAPI_HOME: join(root, 'hapi'), HAPI_LISTEN_HOST: '127.0.0.1',
  HAPI_LISTEN_PORT: String(port), HAPI_PUBLIC_URL: url, HAPI_API_URL: url, PATH: bin + delimiter + process.env.PATH,
  PAC_EXPERIMENTAL: '1', HAPI_DISABLE_VERSION_HANDOFF: '1', PAC_SESSION_DIR: join(root, 'bindings'), PAC_OPENCODE_BINARY: opencode, PAC_RELAY_URL: relayUrl, PAC_NAME: 'testpac',
  PAC_SOURCE_TOKEN_FILE: tokenFile, PAC_CONTROLLER_CWD: remoteCwd, PAC_TRACE_PATH: join(root, 'trace.ndjson'), PAC_SOURCE_BASH: process.env.PAC_TEST_BASH }
const children = []
let diagnosticOutput = ''
let stage = 'starting HAPI hub'
const stageTimer = process.env.PAC_TEST_STAGE_FILE ? setInterval(() => {
  void writeFile(process.env.PAC_TEST_STAGE_FILE, stage, 'utf8').catch(() => {})
}, 2000) : null
stageTimer?.unref()
let jwt
let runnerSessionId
let runnerMachineId
let approvalSessionId
let browser
let browserPage

async function openBrowser() {
  if (browserPage) return browserPage
  if (!process.env.PAC_TEST_PLAYWRIGHT) throw new Error('Playwright is unavailable for browser verification')
  const imported = await import(pathToFileURL(process.env.PAC_TEST_PLAYWRIGHT).href)
  const chromium = (imported.default || imported).chromium
  browser = await chromium.launch({ headless: true, ...(process.env.PAC_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.PAC_TEST_BROWSER_EXECUTABLE } : {}) })
  browserPage = await browser.newPage({ viewport: { width: 1000, height: 800 }, locale: 'en-US' })
  await browserPage.addInitScript(({ token, base }) => { localStorage.setItem(`hapi_access_token::${base}`, token) }, { token: accessToken, base: url })
  return browserPage
}

function launch(args, cwd, executable = hapi) {
  const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const capture = (chunk) => { diagnosticOutput = (diagnosticOutput + chunk.toString('utf8')).slice(-1024 * 1024) }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  child.on('error', () => {})
  children.push(child)
  return child
}
async function request(path, options = {}) {
  const response = await fetch(url + path, { ...options, headers: { ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
    ...(options.body ? { 'content-type': 'application/json' } : {}) }, signal: options.signal ?? AbortSignal.timeout(/\/(spawn|resume|archive|opencode-models)(\?|$)/.test(path) ? 150000 : 30000) })
  if (!response.ok) {
    const body = await response.text()
    const reason = body.includes('Session process is still running and could not be stopped') ? 'session process not confirmed stopped' : 'details unavailable'
    throw new Error(`HAPI HTTP ${response.status}: ${reason}`)
  }
  return response.json()
}
async function until(action, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try { const result = await action(); if (result) return result } catch (error) { lastError = error }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(lastError?.message || 'Timed out')
}

try {
  if (process.env.PAC_HAPI_MCP === '1') {
    await writeFile(join(workspace, 'mcp-fixture.txt'), 'PAC_SOURCE_MCP_RESULT')
    const adapter = fileURLToPath(new URL('../../adapters/pac-acp-agent.mjs', import.meta.url))
    const server = fileURLToPath(new URL('./mock-source-mcp.mjs', import.meta.url))
    const mcp = launch([adapter, 'testmcp', relayUrl, process.env.PAC_MCP_AGENT_TOKEN_FILE, process.execPath, server], workspace, process.execPath)
    await new Promise((resolve) => setTimeout(resolve, 3000))
    if (mcp.exitCode !== null) throw new Error('Source MCP test agent failed to start')
  }
  launch(['hub'], root, hapiHub)
  const auth = await until(() => request('/api/auth', { method: 'POST', body: JSON.stringify({ accessToken }) }), 30000)
  jwt = auth.token
  if (!jwt) throw new Error('HAPI authentication returned no token')
  stage = 'starting HAPI OpenCode session'
  let machineModelOffered = false
  let pacWarningsVerified = false
  let browserUnavailableSelectionVerified = false
  if (process.env.PAC_HAPI_RUNNER === '1') {
    launch(['runner', 'start-sync', '--workspace-root', workspace], root)
    const machine = await until(async () => (await request('/api/machines')).machines?.find((entry) => entry.active), 60000)
    runnerMachineId = machine.id
    stage = 'discovering PAC model before creating a session'
    await until(async () => JSON.stringify(await request(`/api/machines/${machine.id}/opencode-models?cwd=${encodeURIComponent(workspace)}`)).includes('PAC_testpac/sonnet'), 180000)
    machineModelOffered = true
    if (process.env.PAC_HAPI_SKIP_WARNING_PROBE !== '1' && (process.env.PAC_HAPI_INSTRUCTIONS === '1' || process.env.PAC_HAPI_BROWSER === '1')) {
      stage = 'checking PAC discovery warnings through HAPI'
      const warningCwd = join(workspace, 'warning-case')
      await mkdir(warningCwd)
      await mkdir(join(warningCwd, '.claude', 'rules'), { recursive: true })
      await writeFile(join(warningCwd, '.claude', 'rules', 'scoped.md'), '---\npaths: 42\n---\nUnsupported rule paths\n')
      const discovered = await request(`/api/machines/${machine.id}/opencode-models?cwd=${encodeURIComponent(warningCwd)}`)
      if (!discovered.success || !Array.isArray(discovered.availableModels) ||
          !discovered.pacDiscoveryWarnings?.some((warning) => warning.name === 'testpac' && warning.code === 'rule_frontmatter_unsupported')) {
        throw new Error(`HAPI did not expose the expected PAC discovery warning: ${JSON.stringify({ success: discovered.success, warnings: discovered.pacDiscoveryWarnings, models: discovered.availableModels?.length })}`)
      }
      if (process.env.PAC_HAPI_BROWSER === '1') {
        const page = await openBrowser()
        await page.goto(`${url}/sessions/new?directory=${encodeURIComponent(warningCwd)}&machineId=${encodeURIComponent(machine.id)}`)
        await page.locator('input[name="agent"][value="opencode"]').check({ timeout: 45000 })
        const warnings = page.getByTestId('pac-discovery-warnings')
        await warnings.waitFor({ state: 'visible', timeout: 90000 })
        if (!(await warnings.innerText()).includes('frontmatter')) throw new Error('HAPI did not display the PAC project rule warning')
        if (discovered.availableModels.length && !(await page.getByTestId('opencode-model-list').isVisible())) {
          throw new Error('Native models were hidden by a PAC discovery warning')
        }
        await warnings.getByRole('button').click()
        await warnings.waitFor({ state: 'visible', timeout: 90000 })
      }
      pacWarningsVerified = true
    }
    stage = 'creating OpenCode session through the HAPI runner'
    let result
    if (process.env.PAC_HAPI_BROWSER === '1') {
      const page = await openBrowser()
      await page.goto(`${url}/sessions/new?directory=${encodeURIComponent(workspace)}&machineId=${encodeURIComponent(machine.id)}`)
      await page.locator('input[name="agent"][value="opencode"]').check({ timeout: 45000 })
      const model = page.getByTestId('opencode-model-list')
      await model.locator('option[value="PAC_testpac/sonnet"]').waitFor({ state: 'attached', timeout: 90000 })
      await model.selectOption('PAC_testpac/sonnet')
      if (process.env.PAC_HAPI_BROWSER_OFFLINE === '1') {
        stage = 'checking that an unavailable PAC cannot silently change the selected model'
        const probe = '**/api/machines/' + encodeURIComponent(machine.id) + '/opencode-models?*'
        await page.route(probe, (route) => route.fulfill({ json: {
          success: true, availableModels: [{ modelId: 'local/model', name: 'Local model' }], currentModelId: null,
          pacDiscoveryWarnings: [{ name: 'testpac', code: 'unavailable' }],
        } }))
        const offlineResponse = page.waitForResponse((item) => item.url().includes('/opencode-models?cwd=') && item.request().method() === 'GET', { timeout: 30000 })
        await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')))
        await offlineResponse
        await page.getByTestId('pac-discovery-warnings').waitFor({ state: 'visible', timeout: 30000 })
        if (await model.inputValue() !== 'PAC_testpac/sonnet') throw new Error('Unavailable PAC selection was silently replaced')
        if (await page.getByRole('button', { name: 'Create', exact: true }).isEnabled()) throw new Error('HAPI allowed launch with an unavailable PAC')
        await page.unroute(probe)
        await page.getByTestId('pac-discovery-warnings').getByRole('button').click()
        await model.locator('option[value="PAC_testpac/sonnet"]:not(:disabled)').waitFor({ state: 'attached', timeout: 90000 })
        browserUnavailableSelectionVerified = true
      }
      await page.locator('select').filter({ has: page.locator('option[value="yolo"]') }).selectOption('yolo')
      const [response] = await Promise.all([
        page.waitForResponse((item) => item.url().includes(`/api/machines/${machine.id}/spawn`) && item.request().method() === 'POST', { timeout: 150000 }),
        page.getByRole('button', { name: 'Create', exact: true }).click({ timeout: 90000 }),
      ])
      result = await response.json()
      if (!response.ok()) throw new Error('Browser session creation failed')
      const submitted = response.request().postDataJSON()
      if (submitted.agent !== 'opencode' || submitted.model !== 'PAC_testpac/sonnet' || submitted.permissionMode !== 'yolo' || submitted.directory !== workspace) {
        throw new Error('Browser session creation did not preserve the selected PAC, workspace and permission mode')
      }
    } else {
      result = await request(`/api/machines/${machine.id}/spawn`, { method: 'POST', body: JSON.stringify({
        directory: workspace, agent: 'opencode', model: 'PAC_testpac/sonnet', yolo: process.env.PAC_HAPI_CANCEL_PENDING !== '1', startingMode: 'remote'
      }) })
    }
    if (result.type !== 'success' || !result.sessionId) throw new Error('HAPI runner did not create the session')
    runnerSessionId = result.sessionId
  } else {
    launch(['opencode', '--started-by', 'runner', '--hapi-starting-mode', 'remote', '--yolo'], workspace)
  }
  const session = await until(async () => (await request('/api/sessions')).sessions?.find((entry) => entry.metadata?.flavor === 'opencode' && entry.active), 60000)
  const id = session.id
  stage = 'discovering PAC model in HAPI'
  await until(async () => {
    const models = await request(`/api/sessions/${id}/opencode-models`)
    return JSON.stringify(models).includes('PAC_testpac/sonnet')
  }, 60000)
  stage = 'selecting PAC model in HAPI'
  if (runnerSessionId) {
    await until(async () => (await request(`/api/sessions/${id}/opencode-models`)).currentModelId === 'PAC_testpac/sonnet', 60000)
  } else {
    await request(`/api/sessions/${id}/model`, { method: 'POST', body: JSON.stringify({ model: 'PAC_testpac/sonnet' }) })
  }
  stage = 'sending HAPI request'
  const text = `Use Read on ${file}, then use Write to set it to PAC_HAPI_OLD, then use Edit to replace PAC_HAPI_OLD with PAC_HAPI_NEW. Execute all three tools in order.`
  if (process.env.PAC_HAPI_FAST_RESUME !== '1') {
    await request(`/api/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({ text, localId: randomUUID() }) })
    stage = 'waiting for workspace result'
    await until(async () => (await readFile(file, 'utf8')).trim() === 'PAC_HAPI_NEW', 120000)
  }
  const history = await request(`/api/sessions/${id}/messages?limit=100`)
  const visible = JSON.stringify(history)
  const summary = { hapiSession: true, runnerCreatedSession: !!runnerSessionId, machineModelOffered, pacWarningsVerified, browserUnavailableSelectionVerified, modelOffered: true, modelSelected: true, contentsVerified: process.env.PAC_HAPI_FAST_RESUME !== '1',
    readVisible: visible.includes('Read'), writeVisible: visible.includes('Write'), editVisible: visible.includes('Edit') }
  if (process.env.PAC_HAPI_TEXT === '1') {
    stage = 'checking that an actual assistant answer reaches HAPI'
    const before = await request(`/api/sessions/${id}/messages?limit=100`)
    const known = new Set((before.messages || []).map((message) => message.id))
    await request(`/api/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({ text: 'Reply with exactly PAC_HAPI_TEXT_643921 and nothing else. Do not use tools.', localId: randomUUID() }) })
    await until(async () => {
      const page = await request(`/api/sessions/${id}/messages?limit=100`)
      return (page.messages || []).some((message) => !known.has(message.id) && message.content?.role === 'agent' && message.content.content?.data?.type === 'message' && JSON.stringify(message).includes('PAC_HAPI_TEXT_643921'))
    }, 120000)
    summary.assistantTextVerified = true
  }
  if (process.env.PAC_HAPI_BROWSER === '1') summary.browserCreatedSession = true
  if (process.env.PAC_HAPI_SCOPED === '1') {
    stage = 'checking a source path-scoped rule through HAPI'
    await request(`/api/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({
      text: 'What is the scoped marker from the project instructions for the file you just read? Reply with it exactly.', localId: randomUUID()
    }) })
    await until(async () => JSON.stringify((await request(`/api/sessions/${id}/messages?limit=100`)).messages || []).includes('PAC_HAPI_SCOPED_492316'), 120000)
    summary.scopedRuleVerified = true
  }
  if (process.env.PAC_HAPI_SCOPED_SUBAGENT === '1') {
    stage = 'checking that a subagent independently receives a source rule'
    const previous = new Set(((await request(`/api/sessions/${id}/messages?limit=100`)).messages || []).map((message) => message.id))
    await request(`/api/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({
      text: `Use Agent to start a background subagent. It must Read ${file}, follow its project instructions, and return the scoped marker. Wait for the subagent and report its result.`, localId: randomUUID()
    }) })
    await until(async () => {
      const events = (await readFile(env.PAC_TRACE_PATH, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
      const messages = (await request(`/api/sessions/${id}/messages?limit=100`)).messages || []
      return events.some((event) => event.scopedInstructionOwner === 'main') && events.some((event) => event.scopedInstructionOwner === 'subagent') &&
        JSON.stringify(messages.filter((message) => !previous.has(message.id))).includes('PAC_HAPI_SCOPED_492316')
    }, 180000)
    summary.scopedRuleSubagentVerified = true
  }
  if (process.env.PAC_HAPI_MCP === '1') {
    stage = 'calling source MCP tool across the relay'
    await request(`/api/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({
      text: 'Find and call the source_tools read_source_marker MCP tool and report its exact result.', localId: randomUUID()
    }) })
    await until(async () => JSON.stringify((await request(`/api/sessions/${id}/messages?limit=100`)).messages || []).includes('PAC_SOURCE_MCP_RESULT'), 180000)
    summary.sourceMcpCallVerified = true
    stage = 'discovering dynamically registered source MCP tool'
    await request(`/api/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({
      text: 'Find and call the newly registered source_tools dynamic_marker MCP tool and report its exact result.', localId: randomUUID()
    }) })
    await until(async () => JSON.stringify((await request(`/api/sessions/${id}/messages?limit=100`)).messages || []).includes('PAC_DYNAMIC_MCP_RESULT'), 180000)
    summary.dynamicSourceMcpCallVerified = true
  }
  if (process.env.PAC_HAPI_STREAM_SHELL === '1') {
    stage = 'checking live shell output through HAPI'
    const beforeStream = await request(`/api/sessions/${id}/messages?limit=100`)
    const beforeStreamIds = new Set((beforeStream.messages || []).map((message) => message.id))
    await request(`/api/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({
      text: 'Use Bash exactly once to run `printf PAC_STREAM_FIRST; sleep 8; printf PAC_STREAM_LAST` and report the output.', localId: randomUUID()
    }) })
    await until(async () => {
      const page = await request(`/api/sessions/${id}/messages?limit=100`)
      return (page.messages || []).some((message) => !beforeStreamIds.has(message.id) && message.content?.role === 'agent' &&
        message.content.content?.data?.type === 'tool-call' && message.content.content.data.status === 'in_progress' &&
        typeof message.content.content.data.progress?.output === 'string' && message.content.content.data.progress.output.includes('PAC_STREAM_FIRST') &&
        !message.content.content.data.progress.output.includes('PAC_STREAM_LAST'))
    }, 120000)
    await until(async () => {
      const page = await request(`/api/sessions/${id}/messages?limit=100`)
      return (page.messages || []).some((message) => !beforeStreamIds.has(message.id) && message.content?.role === 'agent' &&
        message.content.content?.data?.type === 'tool-call-result' && JSON.stringify(message.content.content.data.output).includes('PAC_STREAM_LAST'))
    }, 120000)
    summary.shellStreamingVerified = true
  }
  if (process.env.PAC_HAPI_CHILD_STREAM === '1') {
    stage = 'checking live shell output from a subagent'
    const beforeStream = await request(`/api/sessions/${id}/messages?limit=100`)
    const beforeStreamIds = new Set((beforeStream.messages || []).map((message) => message.id))
    await request(`/api/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({
      text: 'Use Agent to spawn one subagent. The subagent itself must use Bash exactly once to run `printf PAC_CHILD_STREAM_FIRST; sleep 8; printf PAC_CHILD_STREAM_LAST`, then report the output. Do not run the command in the parent.', localId: randomUUID()
    }) })
    const childCall = await until(async () => {
      const page = await request(`/api/sessions/${id}/messages?limit=100`)
      const message = (page.messages || []).find((entry) => !beforeStreamIds.has(entry.id) && entry.content?.role === 'agent' &&
        entry.content.content?.data?.type === 'tool-call' && entry.content.content.data.status === 'in_progress' &&
        typeof entry.content.content.data.progress?.output === 'string' && entry.content.content.data.progress.output.includes('PAC_CHILD_STREAM_FIRST') &&
        !entry.content.content.data.progress.output.includes('PAC_CHILD_STREAM_LAST'))
      return message?.content?.content?.data?.callId
    }, 120000)
    if (!childCall.startsWith('testpac:')) throw new Error('Subagent shell output was not bound to the child identity')
    await until(async () => {
      const page = await request(`/api/sessions/${id}/messages?limit=100`)
      return (page.messages || []).some((message) => !beforeStreamIds.has(message.id) && message.content?.role === 'agent' &&
        message.content.content?.data?.type === 'tool-call-result' && message.content.content.data.callId === childCall &&
        JSON.stringify(message.content.content.data.output).includes('PAC_CHILD_STREAM_LAST'))
    }, 120000)
    summary.childShellStreamingVerified = true
  }
  if (process.env.PAC_HAPI_CANCEL_SHELL === '1') {
    stage = 'cancelling a running source command through HAPI'
    const marker = join(workspace, 'cancel-started')
    const unwanted = join(workspace, 'cancel-unwanted')
    await request(`/api/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({
      text: 'Use Bash exactly once to run `printf started > cancel-started; sleep 8; printf unwanted > cancel-unwanted`.', localId: randomUUID()
    }) })
    await until(async () => access(marker).then(() => true, () => false), 120000)
    await request(`/api/sessions/${id}/abort`, { method: 'POST', body: '{}' })
    await new Promise((resolve) => setTimeout(resolve, 10000))
    if (await access(unwanted).then(() => true, () => false)) throw new Error('Cancelled source command continued to its side effect')
    summary.shellCancellationVerified = true
  }
  if (process.env.PAC_HAPI_IMAGE === '1') {
    stage = 'reading an image from the source workspace'
    const imagePath = join(workspace, 'image.png')
    await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAsSURBVFhH7c4hAQAADASh61/6F2MGgafVPgkICAgICAgICAgICAgICDwH2gFUDfhqkE3cCgAAAABJRU5ErkJggg==', 'base64'))
    const beforeImage = await request(`/api/sessions/${id}/messages?limit=100`)
    const beforeImageIds = new Set((beforeImage.messages || []).map((message) => message.id))
    await request(`/api/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({
      text: `Use Read on ${imagePath}. What is the dominant color? Answer with only the color.`, localId: randomUUID()
    }) })
    await until(async () => {
      const trace = (await readFile(env.PAC_TRACE_PATH, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
      const page = await request(`/api/sessions/${id}/messages?limit=100`)
      return trace.some((event) => event.imageRead) && (page.messages || []).some((message) => !beforeImageIds.has(message.id) &&
        message.content?.role === 'agent' && message.content.content?.data?.type === 'message' && /\bred\b/i.test(message.content.content.data.message || ''))
    }, 120000)
    summary.imageReadVerified = true
  }
  if (process.env.PAC_HAPI_MODEL_SWITCH === '1') {
    stage = 'switching the model on the selected PAC'
    const modelData = await request(`/api/sessions/${id}/opencode-models`)
    const candidates = (modelData.availableModels || []).map((model) => model.modelId).filter((model) => model.startsWith('PAC_testpac/') && model !== 'PAC_testpac/sonnet')
    const alternate = candidates.find((model) => model.toLowerCase().includes('opus')) || candidates[0]
    if (!alternate) throw new Error('The selected PAC has no alternate model for this test')
    await request(`/api/sessions/${id}/model`, { method: 'POST', body: JSON.stringify({ model: alternate }) })
    const beforeModel = await request(`/api/sessions/${id}/messages?limit=100`)
    const beforeModelIds = new Set((beforeModel.messages || []).map((message) => message.id))
    const traceBeforeModel = (await readFile(env.PAC_TRACE_PATH, 'utf8')).split('\n').filter(Boolean).length
    await request(`/api/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({ text: 'Reply with exactly PAC_MODEL_SWITCH_OK.', localId: randomUUID() }) })
    await until(async () => {
      const page = await request(`/api/sessions/${id}/messages?limit=100`)
      return (page.messages || []).some((message) => !beforeModelIds.has(message.id) && message.content?.role === 'agent' &&
        message.content.content?.data?.type === 'message' && (message.content.content.data.message || '').includes('PAC_MODEL_SWITCH_OK'))
    }, 120000)
    const alternateFamily = ['opus', 'haiku', 'sonnet'].find((family) => alternate.toLowerCase().includes(family))
    if (!alternateFamily) throw new Error('Cannot verify the selected model family')
    const observedAlternate = await until(async () => {
      const trace = (await readFile(env.PAC_TRACE_PATH, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
      return trace.slice(traceBeforeModel).map((event) => event.observedModel).find((model) => typeof model === 'string' && model.toLowerCase().includes(alternateFamily))
    }, 30000)
    await until(async () => (await request(`/api/sessions/${id}/opencode-models`)).currentModelId === alternate, 60000)
    const beforeRestore = await request(`/api/sessions/${id}/messages?limit=100`)
    const beforeRestoreIds = new Set((beforeRestore.messages || []).map((message) => message.id))
    const traceBeforeRestore = (await readFile(env.PAC_TRACE_PATH, 'utf8')).split('\n').filter(Boolean).length
    await request(`/api/sessions/${id}/model`, { method: 'POST', body: JSON.stringify({ model: 'PAC_testpac/sonnet' }) })
    await request(`/api/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({ text: 'Reply with exactly PAC_MODEL_RESTORED.', localId: randomUUID() }) })
    await until(async () => (await request(`/api/sessions/${id}/opencode-models`)).currentModelId === 'PAC_testpac/sonnet', 60000)
    await until(async () => {
      const page = await request(`/api/sessions/${id}/messages?limit=100`)
      return (page.messages || []).some((message) => !beforeRestoreIds.has(message.id) && message.content?.role === 'agent' &&
        message.content.content?.data?.type === 'message' && (message.content.content.data.message || '').includes('PAC_MODEL_RESTORED'))
    }, 120000)
    const observedRestored = await until(async () => {
      const trace = (await readFile(env.PAC_TRACE_PATH, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
      return trace.slice(traceBeforeRestore).map((event) => event.observedModel).find((model) => typeof model === 'string' && model.toLowerCase().includes('sonnet'))
    }, 30000)
    summary.modelSwitchVerified = true
    summary.alternateModel = alternate
    summary.observedAlternateModel = observedAlternate
    summary.observedRestoredModel = observedRestored
  }
  if (process.env.PAC_HAPI_QUESTION === '1') {
    stage = 'requesting interactive answers through HAPI'
    await request(`/api/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({
      text: 'Use AskUserQuestion exactly once with two questions. First ask "What is your custom answer?" with at least two options and allow a custom answer. Second ask "Which colors?" with options Red, Blue, Green and multiSelect true. After receiving answers, repeat them exactly.', localId: randomUUID()
    }) })
    const question = await until(async () => {
      const state = (await request(`/api/sessions/${id}`)).session?.agentState?.requests || {}
      const entry = Object.entries(state).find(([, value]) => value?.tool === 'AskUserQuestion')
      if (!entry) return null
      if (!Array.isArray(entry[1]?.arguments?.questions) || entry[1].arguments.questions.length !== 2 || entry[1].arguments.questions[1].multiSelect !== true) throw new Error('Question shape was not preserved')
      return entry[0]
    }, 120000)
    await until(async () => {
      const page = await request(`/api/sessions/${id}/messages?limit=100`)
      return (page.messages || []).some((message) => message.content?.role === 'agent' && message.content.content?.data?.type === 'tool-call' &&
        message.content.content.data.callId === question && message.content.content.data.name === 'AskUserQuestion')
    }, 30000)
    stage = 'answering the interactive questions through HAPI'
    await request(`/api/sessions/${id}/permissions/${encodeURIComponent(question)}/approve`, { method: 'POST', body: JSON.stringify({ answers: { '0': ['PAC_FREE_TEXT'], '1': ['Red', 'Blue'] } }) })
    await until(async () => {
      const page = await request(`/api/sessions/${id}/messages?limit=100`)
      const agent = (page.messages || []).filter((message) => message.content?.role === 'agent' && message.content.content?.data?.type === 'message')
      const output = JSON.stringify(agent)
      return output.includes('PAC_FREE_TEXT') && output.includes('Red') && output.includes('Blue')
    }, 120000)
    summary.interactiveQuestionsVerified = true
    stage = 'cancelling an interactive question through HAPI'
    const beforeCancel = await request(`/api/sessions/${id}/messages?limit=100`)
    const beforeCancelIds = new Set((beforeCancel.messages || []).map((message) => message.id))
    await request(`/api/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({
      text: 'Use AskUserQuestion exactly once to ask "Continue?" with options Yes and No. If the question is cancelled, stop and do not retry.', localId: randomUUID()
    }) })
    const cancelId = await until(async () => {
      const state = (await request(`/api/sessions/${id}`)).session?.agentState?.requests || {}
      return Object.entries(state).find(([key, value]) => key !== question && value?.tool === 'AskUserQuestion')?.[0]
    }, 120000)
    await request(`/api/sessions/${id}/permissions/${encodeURIComponent(cancelId)}/deny`, { method: 'POST', body: '{}' })
    await until(async () => {
      const page = await request(`/api/sessions/${id}/messages?limit=100`)
      return (page.messages || []).some((message) => !beforeCancelIds.has(message.id) && message.content?.role === 'agent' &&
        message.content.content?.data?.type === 'tool-call-result' && message.content.content.data.is_error === true)
    }, 120000)
    summary.interactiveQuestionCancellationVerified = true
    stage = 'aborting a pending interactive question through HAPI'
    await request(`/api/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({
      text: 'Use AskUserQuestion exactly once to ask "Abort check?" with options Yes and No. Do not retry if cancelled.', localId: randomUUID()
    }) })
    const abortQuestion = await until(async () => {
      const state = (await request(`/api/sessions/${id}`)).session?.agentState?.requests || {}
      return Object.entries(state).find(([key, value]) => key !== question && key !== cancelId && value?.tool === 'AskUserQuestion')?.[0]
    }, 120000)
    await request(`/api/sessions/${id}/abort`, { method: 'POST', body: '{}' })
    await until(async () => !(await request(`/api/sessions/${id}`)).session?.agentState?.requests?.[abortQuestion], 30000)
    let lateApprovalRejected = false
    try { await request(`/api/sessions/${id}/permissions/${encodeURIComponent(abortQuestion)}/approve`, { method: 'POST', body: '{}' }) }
    catch (error) { if (/HAPI HTTP 404/.test(error.message)) lateApprovalRejected = true; else throw error }
    if (!lateApprovalRejected) throw new Error('Aborted question accepted a late approval')
    summary.interactiveQuestionAbortVerified = true
    if (process.env.PAC_HAPI_QUESTION_CHILD === '1') {
      stage = 'asking an interactive question from a subagent'
      const beforeChild = await request(`/api/sessions/${id}/messages?limit=100`)
      const beforeChildIds = new Set((beforeChild.messages || []).map((message) => message.id))
      await request(`/api/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({
        text: 'Use Agent to spawn one subagent. The subagent itself must call AskUserQuestion to ask "Subagent choice?" with two options Alpha and Beta, then report PAC_CHILD_ANSWER_ALPHA if the answer is Alpha. Do not ask the question in the parent.', localId: randomUUID()
      }) })
      const childQuestion = await until(async () => {
        const state = (await request(`/api/sessions/${id}`)).session?.agentState?.requests || {}
        return Object.entries(state).find(([key, value]) => key !== question && key !== cancelId && value?.tool === 'AskUserQuestion')?.[0]
      }, 120000)
      if (!childQuestion.startsWith('testpac:')) throw new Error('Subagent question was not bound to the child identity')
      await request(`/api/sessions/${id}/permissions/${encodeURIComponent(childQuestion)}/approve`, { method: 'POST', body: JSON.stringify({ answers: { '0': ['Alpha'] } }) })
      await until(async () => !(await request(`/api/sessions/${id}`)).session?.agentState?.requests?.[childQuestion], 30000)
      await until(async () => {
        const page = await request(`/api/sessions/${id}/messages?limit=100`)
        return (page.messages || []).some((message) => !beforeChildIds.has(message.id) && message.content?.role === 'agent' &&
          message.content.content?.data?.type === 'message' && (message.content.content.data.message || '').includes('PAC_CHILD_ANSWER_ALPHA'))
      }, 120000)
      summary.childQuestionIdentityVerified = true
    }
  }
  if (process.env.PAC_HAPI_INSTRUCTIONS === '1') {
    const contextMarker = async (text, marker) => {
      const before = await request(`/api/sessions/${id}/messages?limit=100`)
      const known = new Set((before.messages || []).map((message) => message.id))
      await request(`/api/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({ text, localId: randomUUID() }) })
      await until(async () => {
        const page = await request(`/api/sessions/${id}/messages?limit=100`)
        const fresh = (page.messages || []).filter((message) => !known.has(message.id) && message.content?.role === 'agent')
        if (fresh.some((message) => message.content.content?.data?.type === 'tool-call')) throw new Error('Context marker was checked using a tool')
        return fresh.some((message) => message.content.content?.data?.type === 'message' && JSON.stringify(message).includes(marker))
      }, 120000)
    }
    stage = 'checking source project instructions through HAPI'
    await contextMarker('Without using any tools or reading files, what exact marker is specified by the source instructions already in your context? Reply with the marker only.', 'PAC_SOURCE_INSTRUCTION_483729')
    summary.sourceInstructionsVerified = true
    stage = 'checking source project rules through HAPI'
    await contextMarker('Without using any tools or reading files, what exact marker is specified by the source project rule already in your context? Reply with the marker only.', 'PAC_SOURCE_RULE_592174')
    summary.sourceRuleVerified = true
  }
  if (process.env.PAC_HAPI_SKILLS === '1') {
    stage = 'invoking a source project skill through HAPI'
    await request(`/api/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({
      text: 'Use the Skill tool to invoke pac-test-skill with argument HELLO and follow its instructions.', localId: randomUUID()
    }) })
    await until(async () => {
      const page = await request(`/api/sessions/${id}/messages?limit=100`)
      const agent = (page.messages || []).filter((message) => message.content?.role === 'agent' && message.content.content?.data?.type === 'message')
      const events = (await readFile(env.PAC_TRACE_PATH, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
      return JSON.stringify(agent).includes('PAC_SKILL_SUCCESS_HELLO') && events.some((event) => event.skillInvoked === 'pac-test-skill')
    }, 120000)
    summary.sourceSkillVerified = true
  }
  if (process.env.PAC_HAPI_HOOKS === '1') {
    const post = await until(async () => JSON.parse(await readFile(join(workspace, '.claude', 'post-observed.json'), 'utf8')), 30000)
    if (post.tool !== 'Write' || await realpath(post.cwd) !== await realpath(workspace)) throw new Error('Source post-tool hook did not run in the workspace')
    summary.sourcePostHookVerified = true
    stage = 'checking a source project hook through HAPI'
    const blocked = join(workspace, 'hook-block.txt')
    await writeFile(blocked, 'PAC_HOOK_PRIVATE_TEST')
    await request(`/api/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({
      text: `Use Read once on ${blocked}. If denied, stop and do not retry.`, localId: randomUUID()
    }) })
    await until(async () => {
      const events = (await readFile(env.PAC_TRACE_PATH, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
      return events.some((event) => event.hookEvent === 'PreToolUse' && event.tool === 'Read' && event.denied)
    }, 120000)
    const observed = JSON.parse(await readFile(join(workspace, '.claude', 'hook-observed.json'), 'utf8'))
    const events = (await readFile(env.PAC_TRACE_PATH, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
    if (observed.tool !== 'Read' || await realpath(observed.cwd) !== await realpath(workspace) || events.some((event) => event.blockedFixtureRead)) {
      throw new Error('Source hook did not prevent the requested file read')
    }
    summary.sourceHookDenialVerified = true
    stage = 'checking failed source project hooks fail closed'
    const hookErrorFile = join(workspace, 'hook-error.txt')
    await writeFile(hookErrorFile, 'PAC_HOOK_PRIVATE_ERROR_TEST')
    await request(`/api/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({
      text: `Use Read once on ${hookErrorFile}. If the tool fails, stop and do not retry.`, localId: randomUUID()
    }) })
    await until(async () => {
      const log = (await readFile(env.PAC_TRACE_PATH, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
      return log.some((event) => event.hookFailure === true)
    }, 120000)
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const failureEvents = (await readFile(env.PAC_TRACE_PATH, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
    if (failureEvents.some((event) => event.blockedFixtureRead)) throw new Error('A failed project hook allowed the file read')
    summary.sourceHookFailureBlocked = true
    stage = 'checking a source hook after tool execution fails'
    const failureFile = join(workspace, '.claude', 'failure-observed.json')
    if (await access(failureFile).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error })) {
      throw new Error('A pre-execution denial incorrectly triggered the tool failure hook')
    }
    const missing = join(workspace, 'hook-missing.txt')
    await request(`/api/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({
      text: `Use Read exactly once on ${missing}. If it fails, stop and do not retry.`, localId: randomUUID()
    }) })
    const failure = await until(async () => JSON.parse(await readFile(failureFile, 'utf8')), 120000)
    if (failure.tool !== 'Read' || !failure.error || await realpath(failure.cwd) !== await realpath(workspace)) throw new Error('Source failure hook did not receive the expected context')
    summary.sourceToolFailureHookVerified = true
  }
  if (process.env.PAC_HAPI_SEARCH === '1') {
    const searchFile = join(workspace, 'scan-target.txt')
    await writeFile(searchFile, 'PAC_SEARCH_CANARY_734921')
    stage = 'sending source workspace search request'
    const text = `Use Glob with pattern **/*.txt in ${workspace}. Then use Grep with output_mode content to search for SEARCH_CANARY in ${workspace}. Report the results.`
    await request(`/api/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({ text, localId: randomUUID() }) })
    const searchHistory = await until(async () => {
      const page = await request(`/api/sessions/${id}/messages?limit=100`)
      const messages = (page.messages || []).filter((message) => message.content?.role === 'agent')
      const encoded = JSON.stringify(messages)
      const trace = (await readFile(env.PAC_TRACE_PATH, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
      return encoded.includes('PAC_SEARCH_CANARY_734921') && encoded.includes('scan-target.txt') &&
        trace.some((event) => event.searchRequest === 'pac/search/glob') && trace.some((event) => event.searchRequest === 'pac/search/grep') ? encoded : null
    }, 120000)
    summary.searchResultVerified = true
    const toolNames = JSON.parse(searchHistory).map((message) => message.content?.content?.data)
      .filter((data) => data?.type === 'tool-call' && typeof data.name === 'string').map((data) => data.name)
    summary.globVisible = toolNames.some((name) => /^(find|glob)\b/i.test(name))
    summary.grepVisible = toolNames.some((name) => /^grep\b/i.test(name))
    if (!summary.globVisible || !summary.grepVisible) throw new Error('Search tools were not visible in HAPI')
  }
  if (process.env.PAC_HAPI_SHELL === '1') {
    stage = 'sending source workspace shell request'
    const shellPrompt = 'Use Bash to execute exactly: printf PAC_HAPI_SHELL_OUT; printf PAC_HAPI_SHELL_FILE > shell.txt'
    await request(`/api/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({ text: shellPrompt, localId: randomUUID() }) })
    stage = 'waiting for source workspace shell result'
    await until(async () => (await readFile(join(workspace, 'shell.txt'), 'utf8')).trim() === 'PAC_HAPI_SHELL_FILE', 120000)
    summary.shellFileVerified = true
    await until(async () => {
      const historyPage = await request(`/api/sessions/${id}/messages?limit=100`)
      const agentMessages = (historyPage.messages || []).filter((message) => message.content?.role === 'agent' && message.content.content?.data?.type === 'tool-call-result')
      return JSON.stringify(agentMessages).includes('PAC_HAPI_SHELL_OUT') ? JSON.stringify(agentMessages) : null
    }, 30000)
    summary.shellOutputVerified = true
    summary.shellVisible = JSON.stringify(await request(`/api/sessions/${id}/messages?limit=100`)).includes('Bash')
  }
  if (process.env.PAC_HAPI_BACKGROUND_SHELL === '1') {
    stage = 'starting a source background shell command'
    const text = 'Use Bash with run_in_background=true to execute exactly: sleep 15; printf PAC_BG_SHELL_FILE > bg-shell.txt; printf PAC_BG_SHELL_OUT. Return the background task ID immediately.'
    await request(`/api/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({ text, localId: randomUUID() }) })
    let observed = false
    const taskId = await until(async () => {
      const sessions = (await request('/api/sessions')).sessions || []
      if (sessions.find((entry) => entry.id === id)?.backgroundTaskCount > 0) observed = true
      const page = await request(`/api/sessions/${id}/messages?limit=100`)
      const agent = (page.messages || []).filter((message) => message.content?.role === 'agent')
      return JSON.stringify(agent).match(/pac-shell-[0-9a-f-]{36}/)?.[0]
    }, 120000)
    await until(async () => {
      const sessions = (await request('/api/sessions')).sessions || []
      if (sessions.find((entry) => entry.id === id)?.backgroundTaskCount > 0) observed = true
      return (await readFile(join(workspace, 'bg-shell.txt'), 'utf8')).trim() === 'PAC_BG_SHELL_FILE'
    }, 60000)
    stage = 'retrieving background shell output'
    await request(`/api/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({
      text: `Use mcp__pac__TaskOutput with task_id ${taskId} and block true to retrieve that background shell task's output.`, localId: randomUUID()
    }) })
    await until(async () => {
      const page = await request(`/api/sessions/${id}/messages?limit=100`)
      const results = (page.messages || []).filter((message) => message.content?.role === 'agent' && message.content.content?.data?.type === 'tool-call-result')
      return JSON.stringify(results).includes('PAC_BG_SHELL_OUT')
    }, 120000)
    if (!observed) throw new Error('HAPI did not show the background shell task')
    summary.backgroundShellOutputVerified = true
    summary.backgroundShellCountObserved = true
    stage = 'stopping a second source background shell command'
    await request(`/api/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({
      text: 'Use Bash with run_in_background=true to execute exactly: sleep 120; printf UNWANTED > bg-stopped.txt. Return the background task ID immediately.', localId: randomUUID()
    }) })
    stage = 'waiting for the second background shell task ID'
    const stoppedTaskId = await until(async () => {
      const page = await request(`/api/sessions/${id}/messages?limit=100`)
      const agent = (page.messages || []).filter((message) => message.content?.role === 'agent')
      return [...JSON.stringify(agent).matchAll(/pac-shell-[0-9a-f-]{36}/g)].map((match) => match[0]).find((value) => value !== taskId)
    }, 120000)
    let shellStop
    if (process.env.PAC_HAPI_BROWSER_SHELL === '1') {
      const page = await openBrowser()
      await page.goto(`${url}/sessions/${encodeURIComponent(id)}`)
      const controls = page.getByTestId('pac-tasks')
      await controls.waitFor({ state: 'visible', timeout: 45000 })
      await controls.locator('summary').click()
      const [response] = await Promise.all([
        page.waitForResponse((item) => item.url().includes('/pac-tasks/stop') && item.request().method() === 'POST', { timeout: 30000 }),
        controls.getByTestId('pac-stop-task').first().click(),
      ])
      if (!response.ok()) throw new Error('Browser background shell stop failed')
      shellStop = await response.json()
      summary.browserShellStopVerified = true
    } else {
      shellStop = await request(`/api/sessions/${id}/pac-tasks/stop`, { method: 'POST', body: JSON.stringify({ taskId: stoppedTaskId }) })
    }
    if (shellStop.result?.status !== 'stopped') throw new Error('HAPI did not confirm the background shell stop')
    stage = 'waiting for the background shell stop result'
    await until(async () => {
      const events = (await readFile(env.PAC_TRACE_PATH, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
      return events.some((event) => event.shellStop === 'stopped' || event.taskStopStatus === 'stopped')
    }, 120000)
    const stoppedFile = await access(join(workspace, 'bg-stopped.txt')).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error })
    if (stoppedFile) throw new Error('The stopped background task modified the workspace')
    summary.backgroundShellStopVerified = true
  }
  if (process.env.PAC_HAPI_BACKGROUND === '1') {
    const backgroundFile = join(workspace, 'background.txt')
    await writeFile(backgroundFile, 'PAC_BACKGROUND_READ_OK')
    stage = 'sending background subagent request'
    const backgroundPrompt = `Use the Agent tool with run_in_background=true. Ask the subagent to use Read on ${backgroundFile} and return its contents. Wait for completion and report the result.`
    await request(`/api/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({ text: backgroundPrompt, localId: randomUUID() }) })
    stage = 'waiting for background subagent'
    let backgroundObserved = false
    const backgroundHistory = await until(async () => {
      const sessions = (await request('/api/sessions')).sessions || []
      if (sessions.find((entry) => entry.id === id)?.backgroundTaskCount > 0) backgroundObserved = true
      const messages = await request(`/api/sessions/${id}/messages?limit=100`)
      return JSON.stringify(messages).includes('PAC_BACKGROUND_READ_OK') ? messages : null
    }, 120000)
    await until(async () => {
      const events = (await readFile(env.PAC_TRACE_PATH, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
      return events.some((event) => event.translated === 'opencode/session/child_update' && ['completed', 'failed', 'interrupted'].includes(event.status))
    }, 30000)
    const encoded = JSON.stringify(backgroundHistory)
    summary.backgroundReplyVerified = true
    summary.backgroundCountObserved = backgroundObserved
    summary.agentVisible = encoded.includes('Agent')
    summary.backgroundFlagVisible = encoded.includes('run_in_background')
    const trace = (await readFile(env.PAC_TRACE_PATH, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
    summary.backgroundToolObserved = trace.some((event) => event.background === true)
    summary.backgroundSnapshots = trace.filter((event) => Number.isInteger(event.backgroundSnapshot)).map((event) => event.backgroundSnapshot)
    summary.remoteEventTypes = [...new Set(trace.map((event) => event.type).filter(Boolean))]
    summary.childUpdateForwarded = trace.some((event) => event.translated === 'opencode/session/child_update' && event.childUpdate)
    summary.childTerminalObserved = trace.some((event) => event.translated === 'opencode/session/child_update' && ['completed', 'failed', 'interrupted'].includes(event.status))
    if (!summary.backgroundCountObserved || !summary.backgroundToolObserved || !summary.childUpdateForwarded || !summary.childTerminalObserved) throw new Error('Background task acceptance failed: ' + JSON.stringify(summary))
  }
  if (process.env.PAC_HAPI_PARALLEL_AGENTS === '1') {
    stage = 'starting two simultaneous background subagents'
    const first = join(workspace, 'first-background.txt')
    const second = join(workspace, 'second-background.txt')
    await Promise.all([writeFile(first, 'PAC_PARALLEL_FIRST'), writeFile(second, 'PAC_PARALLEL_SECOND')])
    await request(`/api/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({
      text: `Start exactly two Agent calls in parallel, both with run_in_background=true. The first subagent must Read ${first}; the second must Read ${second}. Wait for both results and report both exact contents.`, localId: randomUUID()
    }) })
    let parallelObserved = false
    await until(async () => {
      const sessions = (await request('/api/sessions')).sessions || []
      if ((sessions.find((entry) => entry.id === id)?.backgroundTaskCount || 0) >= 2) parallelObserved = true
      const page = await request(`/api/sessions/${id}/messages?limit=100`)
      const contents = JSON.stringify(page.messages || [])
      return contents.includes('PAC_PARALLEL_FIRST') && contents.includes('PAC_PARALLEL_SECOND')
    }, 180000)
    if (!parallelObserved) throw new Error('Two running background subagents were not observed together')
    summary.parallelBackgroundAgentsVerified = true
  }
  if (process.env.PAC_HAPI_NATIVE_OUTPUT === '1') {
    stage = 'retrieving native background subagent output'
    const source = join(workspace, 'native-output-background.txt')
    await writeFile(source, 'PAC_NATIVE_TASK_OUTPUT')
    await request(`/api/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({
      text: `Use Agent to start one background subagent that reads ${source} and returns its exact contents. Use mcp__pac__TaskOutput with the returned task ID and block=true to get its result, then report the contents.`, localId: randomUUID()
    }) })
    const nativeOutput = await until(async () => {
      const page = await request(`/api/sessions/${id}/messages?limit=100`)
      const events = (page.messages || []).map((message) => message.content?.content?.data).filter(Boolean)
      const call = events.find((event) => event.type === 'tool-call' && /^(mcp__pac__)?TaskOutput$/.test(event.name || '') && typeof event.input?.task_id === 'string')
      const result = call && events.find((event) => event.type === 'tool-call-result' && event.callId === call.callId)
      return result && !result.is_error && JSON.stringify(result.output).includes('PAC_NATIVE_TASK_OUTPUT') ? { taskId: call.input.task_id } : null
    }, 180000)
    summary.nativeSubagentOutputVerified = true
    if (process.env.PAC_HAPI_NATIVE_OUTPUT_RESUME === '1') {
      stage = 'restarting the session to recover a subagent result'
      await request(`/api/sessions/${id}/archive`, { method: 'POST' })
      await until(async () => !(await request(`/api/sessions/${id}`)).session?.active, 60000)
      const resumed = await request(`/api/sessions/${id}/resume`, { method: 'POST', body: '{}' })
      if (resumed.type !== 'success' || resumed.sessionId !== id) throw new Error('Original session was not restored')
      await until(async () => (await request(`/api/sessions/${id}`)).session?.active, 120000)
      const before = await request(`/api/sessions/${id}/messages?limit=100`)
      const existing = new Set((before.messages || []).map((message) => message.id))
      await request(`/api/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({
        text: `Use mcp__pac__TaskOutput with task_id ${nativeOutput.taskId} to retrieve the earlier subagent result, then report it.`, localId: randomUUID()
      }) })
      await until(async () => {
        const page = await request(`/api/sessions/${id}/messages?limit=100`)
        return (page.messages || []).some((message) => !existing.has(message.id) && message.content?.role === 'agent' &&
          message.content.content?.data?.type === 'tool-call-result' && !message.content.content.data.is_error &&
          JSON.stringify(message.content.content.data.output).includes('PAC_NATIVE_TASK_OUTPUT'))
      }, 180000)
      summary.nativeSubagentOutputAfterResumeVerified = true
    }
  }
  if (process.env.PAC_HAPI_AGENT_STOP === '1') {
    stage = 'starting a native background subagent with a running command'
    const visibleModel = (await request(`/api/sessions/${id}`)).session?.model
    if (typeof visibleModel !== 'string' || !visibleModel.startsWith('PAC_')) throw new Error('HAPI session does not expose its PAC model to task controls')
    const unwanted = join(workspace, 'native-agent-unwanted.txt')
    const started = join(workspace, 'native-agent-started.txt')
    const delaySeconds = process.env.PAC_HAPI_BROWSER === '1' ? 90 : 45
    const prompt = `Use Agent to start exactly one background subagent. The subagent must use Bash to run \`printf started > native-agent-started.txt; sleep ${delaySeconds}; printf unwanted > native-agent-unwanted.txt\`. Return its task ID immediately.`
    if (process.env.PAC_HAPI_BROWSER === '1') {
      const page = await openBrowser()
      await page.goto(`${url}/sessions/${encodeURIComponent(id)}`)
      const input = page.locator('[data-testid="rich-composer-input"], textarea').first()
      await input.fill(prompt, { timeout: 45000 })
      const [response] = await Promise.all([
        page.waitForResponse((item) => item.url().includes(`/api/sessions/${id}/messages`) && item.request().method() === 'POST', { timeout: 30000 }),
        input.press('Enter'),
      ])
      if (!response.ok()) throw new Error('Browser message was not accepted')
      summary.browserMessageSent = true
    } else {
      await request(`/api/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({ text: prompt, localId: randomUUID() }) })
    }
    await until(async () => (await readFile(started, 'utf8')).trim() === 'started', 120000)
    stage = 'stopping the native subagent after its command starts'
    const taskId = await until(async () => {
      const session = (await request(`/api/sessions/${id}`)).session
      return session?.backgroundTasks?.find((task) => task.type === 'agent')?.id
    }, 30000)
    if (process.env.PAC_HAPI_BROWSER === '1') {
      const page = await openBrowser()
      await page.goto(`${url}/sessions/${encodeURIComponent(id)}`)
      const controls = page.getByTestId('pac-tasks')
      await controls.waitFor({ state: 'visible', timeout: 45000 })
      await controls.locator('summary').click()
      const [response] = await Promise.all([
        page.waitForResponse((item) => item.url().includes('/pac-tasks/stop') && item.request().method() === 'POST', { timeout: 30000 }),
        controls.getByTestId('pac-stop-task').first().click(),
      ])
      if (!response.ok() || (await response.json()).result?.status !== 'stop_requested') throw new Error('Browser task stop was not accepted')
      summary.browserTaskStopVerified = true
    } else {
      const stopResult = await request(`/api/sessions/${id}/pac-tasks/stop`, { method: 'POST', body: JSON.stringify({ taskId }) })
      if (stopResult.result?.status !== 'stop_requested') throw new Error('Native task stop did not return a stop request')
    }
    await until(async () => {
      const events = (await readFile(env.PAC_TRACE_PATH, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
      return events.some((event) => event.translated === 'opencode/session/child_update' && event.status === 'interrupted')
    }, 60000)
    await new Promise((resolve) => setTimeout(resolve, (delaySeconds + 2) * 1000))
    if (await access(unwanted).then(() => true, () => false)) throw new Error('Stopped native subagent performed its delayed side effect')
    summary.nativeSubagentStopVerified = true
  }
  if (process.env.PAC_HAPI_MULTI === '1') {
    stage = 'starting second named PAC session'
    const secondFile = join(workspace, 'second.txt')
    await writeFile(secondFile, 'PAC_SECOND_INITIAL')
    const secondResult = await request(`/api/machines/${runnerMachineId}/spawn`, { method: 'POST', body: JSON.stringify({
      directory: workspace, agent: 'opencode', model: 'PAC_testpac2/sonnet', yolo: true, startingMode: 'remote'
    }) })
    if (secondResult.type !== 'success' || !secondResult.sessionId) {
      const message = String(secondResult.message || secondResult.errorMessage || '').toLowerCase()
      const category = ['startup is still unconfirmed', 'operation has timed out', 'session webhook timeout', 'request timed out', 'timed out', 'timeout', 'exit', 'directory', 'agent'].find((word) => message.includes(word)) || 'other'
      throw new Error(`HAPI runner did not create the second PAC session (type=${secondResult.type || 'unknown'}, category=${category})`)
    }
    const second = await until(async () => (await request('/api/sessions')).sessions?.find((entry) => entry.id === secondResult.sessionId && entry.active), 60000)
    stage = 'discovering the second PAC model'
    await until(async () => JSON.stringify(await request(`/api/sessions/${second.id}/opencode-models`)).includes('PAC_testpac2/sonnet'), 60000)
    await request(`/api/sessions/${second.id}/model`, { method: 'POST', body: JSON.stringify({ model: 'PAC_testpac2/sonnet' }) })
    stage = 'using the second named PAC'
    const text = `Use Read on ${secondFile}; then use Write to set its content to PAC_SECOND_WRITTEN.`
    await request(`/api/sessions/${second.id}/messages`, { method: 'POST', body: JSON.stringify({ text, localId: randomUUID() }) })
    await until(async () => (await readFile(secondFile, 'utf8')).trim() === 'PAC_SECOND_WRITTEN', 120000)
    summary.secondPacModelOffered = true
    summary.secondPacResultVerified = true
    stage = 'sending requests to two named PAC sessions simultaneously'
    const firstConcurrent = join(workspace, 'concurrent-first.txt')
    const secondConcurrent = join(workspace, 'concurrent-second.txt')
    await Promise.all([writeFile(firstConcurrent, 'PAC_FIRST_INITIAL'), writeFile(secondConcurrent, 'PAC_SECOND_INITIAL')])
    await Promise.all([
      request(`/api/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({
        text: `Use Write exactly once to set ${firstConcurrent} to PAC_FIRST_FINAL. Do not modify any other file.`, localId: randomUUID()
      }) }),
      request(`/api/sessions/${second.id}/messages`, { method: 'POST', body: JSON.stringify({
        text: `Use Write exactly once to set ${secondConcurrent} to PAC_SECOND_FINAL. Do not modify any other file.`, localId: randomUUID()
      }) }),
    ])
    await until(async () => (await readFile(firstConcurrent, 'utf8')).trim() === 'PAC_FIRST_FINAL' &&
      (await readFile(secondConcurrent, 'utf8')).trim() === 'PAC_SECOND_FINAL', 120000)
    summary.simultaneousNamedPacRequestsVerified = true
  }
  if (process.env.PAC_HAPI_APPROVAL === '1') {
    stage = 'creating a session for permission testing'
    const result = process.env.PAC_HAPI_CANCEL_PENDING === '1' ? { type: 'success', sessionId: id } : await request(`/api/machines/${runnerMachineId}/spawn`, { method: 'POST', body: JSON.stringify({
      directory: workspace, agent: 'opencode', model: 'PAC_testpac/sonnet', yolo: false, startingMode: 'remote'
    }) })
    if (result.type !== 'success' || !result.sessionId) {
      const message = String(result.message || result.errorMessage || '').toLowerCase()
      const category = ['operation has timed out', 'session webhook timeout', 'request timed out', 'timed out', 'timeout', 'exit', 'directory', 'agent'].find((word) => message.includes(word)) || 'other'
      throw new Error(`Permission test session was not created (type=${result.type || 'unknown'}, code=${result.code || 'none'}, category=${category})`)
    }
    approvalSessionId = result.sessionId
    await until(async () => (await request(`/api/sessions/${approvalSessionId}/opencode-models`)).currentModelId === 'PAC_testpac/sonnet', 60000)
    stage = 'requesting permission to run a source shell command'
    const text = 'Use Bash once to execute exactly: printf APPROVED > approval.txt'
    await request(`/api/sessions/${approvalSessionId}/messages`, { method: 'POST', body: JSON.stringify({ text, localId: randomUUID() }) })
    const permissionId = await until(async () => {
      const session = (await request(`/api/sessions/${approvalSessionId}`)).session
      return Object.keys(session?.agentState?.requests || {}).find((key) => key.startsWith('pac-terminal-'))
    }, 120000)
    stage = 'approving the shell command through HAPI'
    await request(`/api/sessions/${approvalSessionId}/permissions/${encodeURIComponent(permissionId)}/approve`, { method: 'POST', body: '{}' })
    await until(async () => (await readFile(join(workspace, 'approval.txt'), 'utf8')).trim() === 'APPROVED', 60000)
    summary.shellApprovalVerified = true
    stage = 'denying a second shell command through HAPI'
    const deniedText = 'Use Bash once to execute exactly: printf DENIED > denial.txt. If permission is denied, stop and do not retry.'
    await request(`/api/sessions/${approvalSessionId}/messages`, { method: 'POST', body: JSON.stringify({ text: deniedText, localId: randomUUID() }) })
    const deniedId = await until(async () => {
      const session = (await request(`/api/sessions/${approvalSessionId}`)).session
      return Object.keys(session?.agentState?.requests || {}).find((key) => key.startsWith('pac-terminal-') && key !== permissionId)
    }, 120000)
    await request(`/api/sessions/${approvalSessionId}/permissions/${encodeURIComponent(deniedId)}/deny`, { method: 'POST', body: '{}' })
    await until(async () => !(await request(`/api/sessions/${approvalSessionId}`)).session?.agentState?.requests?.[deniedId], 30000)
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const exists = await access(join(workspace, 'denial.txt')).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error })
    if (exists) throw new Error('The denied command changed the workspace')
    summary.shellDenialVerified = true
    stage = 'denying a workspace write through HAPI'
    const writeFilePath = join(workspace, 'denied-write.txt')
    const writeText = `Use Write once to create ${writeFilePath} containing DENIED. If permission is denied, stop and do not retry.`
    await request(`/api/sessions/${approvalSessionId}/messages`, { method: 'POST', body: JSON.stringify({ text: writeText, localId: randomUUID() }) })
    const filePermissionId = await until(async () => {
      const session = (await request(`/api/sessions/${approvalSessionId}`)).session
      return Object.keys(session?.agentState?.requests || {}).find((key) => key.startsWith('pac-file-'))
    }, 120000)
    await request(`/api/sessions/${approvalSessionId}/permissions/${encodeURIComponent(filePermissionId)}/deny`, { method: 'POST', body: '{}' })
    await until(async () => !(await request(`/api/sessions/${approvalSessionId}`)).session?.agentState?.requests?.[filePermissionId], 30000)
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const written = await access(writeFilePath).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error })
    if (written) throw new Error('The denied write changed the workspace')
    summary.fileWriteDenialVerified = true
    if (process.env.PAC_HAPI_CANCEL_PENDING === '1') {
      stage = 'cancelling a pending source command approval'
      const blockedFile = join(workspace, 'pending-cancel-unwanted')
      await request(`/api/sessions/${approvalSessionId}/messages`, { method: 'POST', body: JSON.stringify({
        text: 'Use Bash exactly once to run `printf unwanted > pending-cancel-unwanted`.', localId: randomUUID()
      }) })
      const pendingId = await until(async () => {
        const state = (await request(`/api/sessions/${approvalSessionId}`)).session?.agentState?.requests || {}
        return Object.keys(state).find((key) => key.startsWith('pac-terminal-') && key !== permissionId && key !== deniedId)
      }, 120000)
      await request(`/api/sessions/${approvalSessionId}/abort`, { method: 'POST', body: '{}' })
      await until(async () => !(await request(`/api/sessions/${approvalSessionId}`)).session?.agentState?.requests?.[pendingId], 30000)
      let lateApproved = false
      try {
        await request(`/api/sessions/${approvalSessionId}/permissions/${encodeURIComponent(pendingId)}/approve`, { method: 'POST', body: '{}' })
        lateApproved = true
      } catch (error) { if (!/^HAPI HTTP 404:/.test(error.message)) throw error }
      if (lateApproved) throw new Error('Cancelled source command remained approvable')
      await new Promise((resolve) => setTimeout(resolve, 2000))
      if (await access(blockedFile).then(() => true, () => false)) throw new Error('Cancelled pending source command ran')
      summary.pendingApprovalCancellationVerified = true
      stage = 'cancelling a pending source write approval'
      const blockedWrite = join(workspace, 'pending-cancel-write.txt')
      await request(`/api/sessions/${approvalSessionId}/messages`, { method: 'POST', body: JSON.stringify({
        text: `Use Write exactly once to create ${blockedWrite} containing UNWANTED.`, localId: randomUUID()
      }) })
      const pendingWrite = await until(async () => {
        const state = (await request(`/api/sessions/${approvalSessionId}`)).session?.agentState?.requests || {}
        return Object.keys(state).find((key) => key.startsWith('pac-file-') && key !== filePermissionId)
      }, 120000)
      await request(`/api/sessions/${approvalSessionId}/abort`, { method: 'POST', body: '{}' })
      await until(async () => !(await request(`/api/sessions/${approvalSessionId}`)).session?.agentState?.requests?.[pendingWrite], 30000)
      let lateWriteApproved = false
      try {
        await request(`/api/sessions/${approvalSessionId}/permissions/${encodeURIComponent(pendingWrite)}/approve`, { method: 'POST', body: '{}' })
        lateWriteApproved = true
      } catch (error) { if (!/^HAPI HTTP 404:/.test(error.message)) throw error }
      if (lateWriteApproved) throw new Error('Cancelled source write remained approvable')
      await new Promise((resolve) => setTimeout(resolve, 2000))
      if (await access(blockedWrite).then(() => true, () => false)) throw new Error('Cancelled pending source write ran')
      summary.pendingWriteCancellationVerified = true
      stage = 'cancelling a pending background command approval'
      const blockedBackground = join(workspace, 'pending-background-unwanted')
      await request(`/api/sessions/${approvalSessionId}/messages`, { method: 'POST', body: JSON.stringify({
        text: 'Use Bash with run_in_background=true exactly once to run `printf unwanted > pending-background-unwanted`.', localId: randomUUID()
      }) })
      const pendingBackground = await until(async () => {
        const state = (await request(`/api/sessions/${approvalSessionId}`)).session?.agentState?.requests || {}
        return Object.keys(state).find((key) => key.startsWith('pac-terminal-') && key !== permissionId && key !== deniedId && key !== pendingId)
      }, 120000)
      await request(`/api/sessions/${approvalSessionId}/abort`, { method: 'POST', body: '{}' })
      await until(async () => !(await request(`/api/sessions/${approvalSessionId}`)).session?.agentState?.requests?.[pendingBackground], 30000)
      let lateBackgroundApproved = false
      try {
        await request(`/api/sessions/${approvalSessionId}/permissions/${encodeURIComponent(pendingBackground)}/approve`, { method: 'POST', body: '{}' })
        lateBackgroundApproved = true
      } catch (error) { if (!/^HAPI HTTP 404:/.test(error.message)) throw error }
      if (lateBackgroundApproved) throw new Error('Cancelled background command remained approvable')
      await new Promise((resolve) => setTimeout(resolve, 2000))
      if (await access(blockedBackground).then(() => true, () => false)) throw new Error('Cancelled pending background command ran')
      summary.pendingBackgroundCancellationVerified = true
    }
  }
  if (process.env.PAC_HAPI_COMPACT === '1') {
    stage = 'recording a marker before HAPI compaction'
    const marker = 'PAC_COMPACT_MARKER_781523'
    await request(`/api/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({
      text: `Remember ${marker} for a later question. Reply READY.`, localId: randomUUID()
    }) })
    await until(async () => {
      const page = await request(`/api/sessions/${id}/messages?limit=100`)
      return (page.messages || []).some((message) => message.content?.role === 'agent' && message.content.content?.data?.type === 'message' && /\bREADY\b/.test(message.content.content.data.message || ''))
    }, 120000)
    const before = new Set(((await request(`/api/sessions/${id}/messages?limit=100`)).messages || []).map((message) => message.id))
    stage = 'compacting the PAC conversation through HAPI'
    await request(`/api/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({ text: '/compact', localId: randomUUID() }) })
    await until(async () => {
      const page = await request(`/api/sessions/${id}/messages?limit=100`)
      const fresh = (page.messages || []).filter((message) => !before.has(message.id))
      if (fresh.some((message) => /compaction failed|not yet supported/i.test(JSON.stringify(message)))) throw new Error('HAPI reported compaction failure for the PAC session')
      return fresh.some((message) => message.content?.role === 'agent' && message.content.content?.data?.type === 'compact-summary')
    }, 180000)
    stage = 'checking remembered context after compaction'
    const beforeRecall = new Set(((await request(`/api/sessions/${id}/messages?limit=100`)).messages || []).map((message) => message.id))
    await request(`/api/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({ text: 'Repeat the remembered marker exactly.', localId: randomUUID() }) })
    await until(async () => ((await request(`/api/sessions/${id}/messages?limit=100`)).messages || []).some((message) => !beforeRecall.has(message.id) && message.content?.role === 'agent' && message.content.content?.data?.type === 'message' && (message.content.content.data.message || '').includes(marker)), 120000)
    summary.compactionAndRecallVerified = true
  }
  if (process.env.PAC_HAPI_RESUME === '1') {
    stage = 'recording context before session restart'
    const before = await request(`/api/sessions/${id}/messages?limit=100`)
    const previousIds = new Set((before.messages || []).map((message) => message.id))
    const canary = `PAC_RESUME_${randomBytes(8).toString('hex')}`
    const text = `Remember the exact marker ${canary} for the next request. Reply only with READY.`
    await request(`/api/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({ text, localId: randomUUID() }) })
    await until(async () => {
      const page = await request(`/api/sessions/${id}/messages?limit=100`)
      return (page.messages || []).some((message) => !previousIds.has(message.id) && message.content?.role === 'agent' &&
        message.content.content?.data?.type === 'message' && /\bREADY\b/.test(message.content.content.data.message || ''))
    }, 120000)
    stage = 'restarting the HAPI session'
    await request(`/api/sessions/${id}/archive`, { method: 'POST' })
    await until(async () => !(await request(`/api/sessions/${id}`)).session?.active, 60000)
    stage = 'requesting HAPI session resume'
    const resumed = await request(`/api/sessions/${id}/resume`, { method: 'POST', body: '{}' })
    if (resumed.type !== 'success' || !resumed.sessionId) throw new Error('HAPI did not resume the session')
    runnerSessionId = resumed.sessionId
    await until(async () => (await request(`/api/sessions/${resumed.sessionId}/opencode-models`)).currentModelId === 'PAC_testpac/sonnet', 120000)
    const resumedHistory = await request(`/api/sessions/${resumed.sessionId}/messages?limit=100`)
    const resumedIds = new Set((resumedHistory.messages || []).map((message) => message.id))
    await request(`/api/sessions/${resumed.sessionId}/messages`, { method: 'POST', body: JSON.stringify({
      text: 'What exact marker did I ask you to remember in my previous request? Reply with the marker only.', localId: randomUUID()
    }) })
    await until(async () => {
      const page = await request(`/api/sessions/${resumed.sessionId}/messages?limit=100`)
      return (page.messages || []).some((message) => !resumedIds.has(message.id) && message.content?.role === 'agent' &&
        message.content.content?.data?.type === 'message' && (message.content.content.data.message || '').includes(canary))
    }, 120000)
    const resumedFile = join(workspace, 'resumed.txt')
    stage = 'checking a source write after HAPI session resume'
    await request(`/api/sessions/${resumed.sessionId}/messages`, { method: 'POST', body: JSON.stringify({
      text: `Use Write to create ${resumedFile} containing PAC_RESUMED_WRITE.`, localId: randomUUID()
    }) })
    await until(async () => (await readFile(resumedFile, 'utf8')).trim() === 'PAC_RESUMED_WRITE', 120000)
    summary.resumeContextVerified = true
    summary.resumeModelVerified = true
    summary.resumeToolVerified = true
    if (process.env.PAC_HAPI_SKILLS === '1') {
      stage = 'invoking the source skill after session restart'
      const invocationsBefore = (await readFile(env.PAC_TRACE_PATH, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
        .filter((event) => event.skillInvoked === 'pac-test-skill').length
      await request(`/api/sessions/${resumed.sessionId}/messages`, { method: 'POST', body: JSON.stringify({
        text: 'Use the Skill tool to invoke pac-test-skill with argument AGAIN and follow its instructions.', localId: randomUUID()
      }) })
      await until(async () => {
        const page = await request(`/api/sessions/${resumed.sessionId}/messages?limit=100`)
        const agent = (page.messages || []).filter((message) => message.content?.role === 'agent' && message.content.content?.data?.type === 'message')
        const invocations = (await readFile(env.PAC_TRACE_PATH, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
          .filter((event) => event.skillInvoked === 'pac-test-skill').length
        return JSON.stringify(agent).includes('PAC_SKILL_SUCCESS_AGAIN') && invocations > invocationsBefore
      }, 120000)
      summary.resumeSkillVerified = true
    }
  }
  process.stdout.write(JSON.stringify(summary) + '\n')
} catch (error) {
  process.stderr.write(`${stage}: ${error.message}\n`)
  try {
    const directory = join(root, 'hapi', 'logs')
    const files = await readdir(directory)
    const logs = (await Promise.all(files.filter((name) => name.endsWith('.log')).map((name) => readFile(join(directory, name), 'utf8')))).join('\n')
    process.stderr.write(`Diagnostic runner flags: ${JSON.stringify(Object.fromEntries(['still_alive', 'already_gone', 'unknown', 'timeout', 'kill failed', 'tree-kill'].map((word) => [word, logs.toLowerCase().includes(word)])))}\n`)
    process.stderr.write(`Diagnostic runner counts: ${JSON.stringify(Object.fromEntries(['Spawning session', 'Waiting for session webhook', 'Session webhook:', 'Session webhook timeout', 'Process tree'].map((word) => [word, logs.split(word).length - 1])))}\n`)
    process.stderr.write(`Diagnostic notification counts: ${JSON.stringify(Object.fromEntries(['Reporting session', 'Reported session', 'Failed to report to runner', 'Runner is not running', 'No runner running', 'Session started:'].map((word) => [word, logs.split(word).length - 1])))}\n`)
  } catch {}
  try {
    const trace = (await readFile(env.PAC_TRACE_PATH, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const diagnostics = trace.filter((event) => event.type === 'tool_call' || event.shellStop || event.shellBackgroundCount || event.skillInvoked)
      .slice(-15).map((event) => ({ type: event.type, tool: event.title?.split(/\s/)[0], shellStop: event.shellStop,
        shellBackgroundCount: event.shellBackgroundCount, skillInvoked: event.skillInvoked, background: event.background }))
    process.stderr.write(`Diagnostic events: ${JSON.stringify(diagnostics)}\n`)
    process.stderr.write(`Diagnostic event kinds: ${JSON.stringify(trace.slice(-15).map((event) => ({ type: event.type, keys: Object.keys(event).sort() })))}\n`)
    process.stderr.write(`Diagnostic connection phases: ${JSON.stringify(trace.filter((event) => event.connectionStage).slice(-20).map((event) => ({ stage: event.connectionStage, elapsedMs: event.elapsedMs })))}\n`)
    process.stderr.write(`Diagnostic task control: ${JSON.stringify(trace.filter((event) => event.taskStopStatus || event.taskStopError).slice(-10))}\n`)
  } catch {}
  process.stderr.write(`Diagnostic process flags: ${JSON.stringify(Object.fromEntries(['session process is still running', 'timed out', 'timeout', 'rpc', 'error'].map((word) => [word, diagnosticOutput.toLowerCase().includes(word)])))}\n`)
  if (jwt && runnerSessionId) {
    try {
      const page = await request(`/api/sessions/${runnerSessionId}/messages?limit=100`)
      const results = JSON.stringify((page.messages || []).filter((message) => message.content?.content?.data?.type === 'tool-call-result')).toLowerCase()
      process.stderr.write(`Diagnostic task result categories: ${JSON.stringify(Object.fromEntries(['stop_requested', 'completed', 'unknown native subagent', 'cancellation is unavailable', 'sdk rejected'].map((word) => [word, results.includes(word)])))}\n`)
      process.stderr.write(`Diagnostic message kinds: ${JSON.stringify((page.messages || []).slice(-10).map((message) => ({ role: message.content?.role,
        type: message.content?.content?.data?.type, keys: Object.keys(message.content?.content?.data || {}).sort() })))}\n`)
      const syntheticOutput = JSON.stringify((page.messages || []).map((message) => message.content?.content?.data || {})).toLowerCase()
      process.stderr.write(`Diagnostic tool categories: ${JSON.stringify(Object.fromEntries(['permission', 'denied', 'not found', 'unavailable', 'no tools', 'toolsearch', 'write', 'edit', 'error', 'inactive', 'outside', 'workspace', 'connection', 'session', 'model', 'no such', 'read_text_file', 'unknown', 'failed'].map((word) => [word, syntheticOutput.includes(word)])))}\n`)
      const resultsByCall = (page.messages || []).map((message) => message.content?.content?.data).filter((data) => data?.type === 'tool-call-result')
      process.stderr.write(`Diagnostic tool result flags: ${JSON.stringify(resultsByCall.map((data) => ({ error: data.is_error === true, hasFixture: JSON.stringify(data.output).includes('PAC_HAPI_INITIAL') })))}\n`)
      const questionErrors = ['PAC interactive questions are disabled', 'PAC question has no valid originating tool identity', 'PAC question owner cannot be determined', 'PAC question owner is no longer active', 'PAC question was cancelled', 'Invalid PAC question request']
      process.stderr.write(`Diagnostic question errors: ${JSON.stringify(questionErrors.filter((value) => JSON.stringify(resultsByCall).includes(value)))}\n`)
    } catch {}
  }
  process.exitCode = 1
} finally {
  stage = 'closing the isolated test browser'
  if (browser) await browser.close().catch(() => {})
  stage = 'archiving isolated test sessions'
  if (jwt) {
    const sessionIds = new Set([approvalSessionId, runnerSessionId].filter(Boolean))
    try {
      for (const session of (await request('/api/sessions', { signal: AbortSignal.timeout(10000) })).sessions || []) if (session.id) sessionIds.add(session.id)
    } catch {}
    for (const sessionId of sessionIds) {
      try { await request(`/api/sessions/${sessionId}/archive`, { method: 'POST', signal: AbortSignal.timeout(10000) }) } catch {}
    }
  }
  stage = 'stopping isolated test processes'
  let processCleanupUncertain = false
  for (const child of children.reverse()) if (child.pid && child.exitCode === null) {
    const result = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 })
    if (result.error) {
      process.stderr.write(`Could not confirm isolated process cleanup: ${result.error.message}\n`)
      process.exitCode = 1
      processCleanupUncertain = true
    }
  }
  stage = 'removing the isolated test workspace'
  const realTemp = await realpath(tmpdir())
  const realRoot = await realpath(root)
  const local = relative(realTemp, realRoot)
  if (!processCleanupUncertain && local && local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local) && local.startsWith('pac-hapi-proof-')) await rm(realRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  stage = 'isolated test cleanup finished'
  if (stageTimer) clearInterval(stageTimer)
}
