import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { browserWorkspaceDisposition } from './browser-workspace-policy.mjs'

if (process.env.PAC_TEST_INSTALLED !== '1' || !process.env.PAC_TEST_PLAYWRIGHT) throw new Error('Installed browser test requires explicit opt-in and Playwright')
const profile = process.env.PAC_TEST_HAPI_HOME
if (!profile || !isAbsolute(profile)) throw new Error('Installed browser test requires an explicit absolute profile path')
const json = async name => JSON.parse((await readFile(join(profile, name), 'utf8')).replace(/^\uFEFF/, ''))
const settings = await json('settings.json'), connection = await json('connection.json')
const base = connection.publicUrl.replace(/\/$/, ''), api = `http://127.0.0.1:${connection.relayPort}`
const waitMs = Number(process.env.PAC_TEST_TIMEOUT_MS || 180000)
if (!Number.isSafeInteger(waitMs) || waitMs < 1000 || waitMs > 900000) throw new Error('Invalid browser test timeout')
const parent = await realpath(join(homedir(), 'sma-test'))
const workspace = await mkdtemp(join(parent, 'pac-browser-proof-'))
const marker = `PAC_BROWSER_${randomUUID()}`
const started = Date.now()
const stage = name => console.log(JSON.stringify({ stage: name, elapsedMs: Date.now() - started }))
await writeFile(join(workspace, 'fixture.txt'), marker)
let browser, jwt, sessionId, creationAttempted = false, archived = false
async function request(path, method = 'GET', data) {
  const response = await fetch(api + path, { method, headers: { ...(jwt ? { authorization: `Bearer ${jwt}` } : {}), ...(data ? { 'content-type': 'application/json' } : {}) },
    ...(data ? { body: JSON.stringify(data) } : {}), signal: AbortSignal.timeout(150000) })
  if (!response.ok) throw Object.assign(new Error(`HAPI ${method} returned ${response.status}`), { status: response.status })
  return response.status === 204 ? {} : response.json()
}
async function until(action, timeout = waitMs) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await action()) return; await new Promise(resolve => setTimeout(resolve, 1000)) }
  throw new Error('Browser verification timed out')
}
try {
  const imported = await import(pathToFileURL(process.env.PAC_TEST_PLAYWRIGHT).href)
  browser = await (imported.default || imported).chromium.launch({ headless: true,
    ...(process.env.PAC_TEST_BROWSER_PROXY ? { proxy: { server: process.env.PAC_TEST_BROWSER_PROXY } } : {}),
    ...(process.env.PAC_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.PAC_TEST_BROWSER_EXECUTABLE } : {}) })
  jwt = (await request('/api/auth', 'POST', { accessToken: settings.cliApiToken })).token
  const machine = (await request('/api/machines')).machines.find(item => item.active && item.id === settings.machineId)
  if (!jwt || !machine) throw new Error('Existing HAPI runner unavailable')
  stage('runner-available')
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  const url = `${base}/sessions/new?directory=${encodeURIComponent(workspace)}&machineId=${encodeURIComponent(machine.id)}`
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  const password = page.locator('input[type="password"]')
  await password.fill(settings.cliApiToken, { timeout: 30000 })
  await password.press('Enter')
  await password.waitFor({ state: 'hidden', timeout: 30000 })
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.locator('input[name="agent"][value="opencode"]').check({ timeout: 45000 })
  const model = page.getByTestId('opencode-model-list')
  await model.locator('option[value="PAC_testpac/sonnet"]').waitFor({ state: 'attached', timeout: 90000 })
  await model.selectOption('PAC_testpac/sonnet')
  stage('model-selected')
  const permissions = page.locator('select').filter({ has: page.locator('option[value="yolo"]') })
  if (await permissions.count()) await permissions.selectOption('yolo')
  creationAttempted = true
  const [created] = await Promise.all([
    page.waitForResponse(item => item.url().includes(`/api/machines/${machine.id}/spawn`) && item.request().method() === 'POST', { timeout: 150000 }),
    page.getByRole('button', { name: /^(Create|Создать)$/i }).click({ timeout: 90000 }),
  ])
  const result = await created.json()
  if (!created.ok() || result.type !== 'success' || !result.sessionId) throw new Error('Browser session creation failed')
  sessionId = result.sessionId
  stage('session-created')
  const submitted = created.request().postDataJSON()
  if (submitted.agent !== 'opencode' || submitted.model !== 'PAC_testpac/sonnet' || submitted.directory !== workspace) throw new Error('Browser did not submit the selected PAC model and workspace')
  await page.goto(`${base}/sessions/${encodeURIComponent(sessionId)}`, { waitUntil: 'domcontentloaded' })
  const input = page.locator('[data-testid="rich-composer-input"], textarea').first()
  await input.fill('Read fixture.txt in the current workspace and reply with its exact contents.', { timeout: 45000 })
  const [sent] = await Promise.all([
    page.waitForResponse(item => item.url().includes(`/api/sessions/${sessionId}/messages`) && item.request().method() === 'POST', { timeout: 30000 }),
    input.press('Enter'),
  ])
  if (!sent.ok()) throw new Error('Browser message submission failed')
  stage('prompt-sent')
  await until(async () => (await request(`/api/sessions/${sessionId}/messages?limit=100`)).messages?.some(message =>
    message.content?.role === 'agent' && message.content?.content?.data?.type === 'message' && (message.content.content.data.message || '').includes(marker)))
  await page.getByText(marker, { exact: false }).first().waitFor({ state: 'visible', timeout: 45000 })
  stage('read-response-visible')
  const before = new Set(((await request(`/api/sessions/${sessionId}/messages?limit=100`)).messages || []).map(message => message.id))
  await input.fill('Use Write to create proof.txt with OLD_CONTENT, then Edit to replace OLD_CONTENT with NEW_CONTENT. Use Glob to find proof.txt, Grep to find NEW_CONTENT, and Bash to run `printf SHELL_SUCCESS > shell-result.txt`. Do all five tools in that order, then report DONE.', { timeout: 45000 })
  const [followup] = await Promise.all([
    page.waitForResponse(item => item.url().includes(`/api/sessions/${sessionId}/messages`) && item.request().method() === 'POST', { timeout: 30000 }),
    input.press('Enter'),
  ])
  if (!followup.ok()) throw new Error('Browser follow-up submission failed')
  stage('followup-sent')
  await until(async () => {
    try {
      const messages = (await request(`/api/sessions/${sessionId}/messages?limit=100`)).messages || []
      const recent = messages.filter(message => !before.has(message.id) && message.content?.role === 'agent')
      return recent.some(message => message.content?.content?.data?.type === 'ready') &&
        (await readFile(join(workspace, 'proof.txt'), 'utf8')).trim() === 'NEW_CONTENT' &&
        (await readFile(join(workspace, 'shell-result.txt'), 'utf8')).trim() === 'SHELL_SUCCESS'
    } catch { return false }
  })
  const messages = (await request(`/api/sessions/${sessionId}/messages?limit=100`)).messages || []
  const events = []
  for (const message of messages.filter(message => !before.has(message.id) && message.content?.role === 'agent')) {
    const text = message.content?.content?.data?.message || ''
    for (const match of text.matchAll(/\[PAC tool event\]\s*(\{[^\n]*\})/g)) {
      try { events.push(JSON.parse(match[1])) } catch {}
    }
  }
  const tools = { Write: events.some(event => /^Write\b/.test(event.title || '')), Edit: events.some(event => /^Edit\b/.test(event.title || '')),
    Glob: events.some(event => event.kind === 'search' && /^Find\b/.test(event.title || '')),
    Grep: events.some(event => event.kind === 'search' && /^grep\b/i.test(event.title || '')),
    Bash: events.some(event => event.kind === 'execute') }
  if (Object.values(tools).some(value => !value)) throw new Error('Not all requested source tools were observed in HAPI')
  stage('tools-verified')
  console.log(JSON.stringify({ browserSelectedModel: true, browserCreatedSession: true, browserSentPrompt: true, sourceReadAndResponse: true, browserFollowup: true, sourceTools: tools }))
} finally {
  if (browser) await browser.close()
  if (sessionId && jwt) {
    try { await request(`/api/sessions/${sessionId}/archive`, 'POST') } catch {}
    try { const session = (await request(`/api/sessions/${sessionId}`)).session; archived = session?.metadata?.lifecycleState === 'archived' && session.active === false } catch {}
    if (!archived) { console.error(`Browser test archive is unconfirmed: ${sessionId}`); process.exitCode = 1 }
  }
  const disposition = browserWorkspaceDisposition({ creationAttempted, keep: process.env.PAC_TEST_KEEP_WORKSPACE === '1' })
  if (disposition === 'retain') {
    console.log(JSON.stringify({ archived, workspaceRetained: workspace }))
  } else if (disposition === 'remove') {
    const actual = await realpath(workspace), local = relative(parent, actual)
    if (!local || isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`) || !local.startsWith('pac-browser-proof-')) throw new Error('Refusing to remove an unexpected browser workspace')
    const deadline = Date.now() + 11 * 60 * 1000
    while (true) {
      try { await rm(actual, { recursive: true, force: true }); break }
      catch (error) {
        if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code) || Date.now() >= deadline) throw error
        await new Promise(resolve => setTimeout(resolve, 5000))
      }
    }
    console.log(JSON.stringify({ archived, workspaceRemoved: true }))
  } else { console.error(`Browser test workspace retained pending ownership-safe process verification; inspect session ${sessionId || 'unknown'} and workspace ${workspace}`); process.exitCode = 1 }
}
