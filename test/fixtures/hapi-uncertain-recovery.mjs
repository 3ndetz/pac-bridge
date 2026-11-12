import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

if (process.env.PAC_TEST_INSTALLED !== '1') throw new Error('Explicit installed-test opt-in required')
const exec = promisify(execFile), home = homedir(), root = join(home, 'sma-test', `pac-uncertain-${randomUUID()}`)
const profile = process.env.PAC_TEST_HAPI_HOME || join(home, '.hapi-servermall'), model = process.env.PAC_TEST_MODEL || 'PAC_testpac/sonnet'
const json = async f => JSON.parse((await readFile(join(profile, f), 'utf8')).replace(/^\uFEFF/, ''))
const settings = await json('settings.json'), connection = await json('connection.json'), base = `http://127.0.0.1:${connection.relayPort}`
const journal = join(profile, 'pac-bridge', 'bindings', 'pending')
const recovery = fileURLToPath(new URL('../../scripts/reconcile-uncertain-turn.mjs', import.meta.url))
let jwt, id, archived = false, archiveAttempted = false
await mkdir(root, { recursive: true })
async function request(path, method = 'GET', data) {
  const response = await fetch(base + path, { method, headers: { ...(jwt ? { authorization: `Bearer ${jwt}` } : {}), ...(data ? { 'content-type': 'application/json' } : {}) },
    ...(data ? { body: JSON.stringify(data) } : {}), signal: AbortSignal.timeout(150000) })
  if (!response.ok) throw Object.assign(new Error(`HAPI ${method} returned ${response.status}`), { status: response.status })
  return response.status === 204 ? {} : response.json()
}
async function until(fn, timeout = 240000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const result = await fn(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 1000)) }
  throw new Error('Timed out waiting for recovery proof')
}
async function messages() { return (await request(`/api/sessions/${id}/messages?limit=100`)).messages || [] }
async function send(text) {
  const data = { text, localId: randomUUID() }, end = Date.now() + 60000
  while (true) { try { return await request(`/api/sessions/${id}/messages`, 'POST', data) } catch (error) {
    if (error.status !== 409 || Date.now() > end) throw error; await new Promise(resolve => setTimeout(resolve, 1000))
  } }
}
async function turn(text, marker) {
  const previous = new Set((await messages()).map(message => message.id)); await send(text)
  await until(async () => {
    const recent = (await messages()).filter(message => !previous.has(message.id) && message.content?.role === 'agent')
    if (recent.some(message => message.content?.content?.data?.type === 'error')) throw new Error('HAPI reported an error during the test turn')
    return recent.some(message => message.content?.content?.data?.type === 'message' && (message.content.content.data.message || '').includes(marker))
  })
}
try {
  jwt = (await request('/api/auth', 'POST', { accessToken: settings.cliApiToken })).token
  const machine = (await request('/api/machines')).machines.find(item => item.active && item.id === settings.machineId)
  if (!machine) throw new Error('Existing runner unavailable')
  const models = await request(`/api/machines/${machine.id}/opencode-models?cwd=${encodeURIComponent(root)}`)
  if (!JSON.stringify(models).includes(model)) throw new Error('PAC model unavailable')
  const created = await request(`/api/machines/${machine.id}/spawn`, 'POST', { directory: root, agent: 'opencode', model, yolo: true, startingMode: 'remote' })
  if (created.type !== 'success' || !created.sessionId) throw new Error('Could not create test session')
  id = created.sessionId
  await turn('Remember PAC_RECOVERY_MEMORY_68721 and reply PAC_RECOVERY_READY_68721.', 'PAC_RECOVERY_READY_68721')
  const sessionId = await until(async () => (await request(`/api/sessions/${id}`)).session?.metadata?.opencodeSessionId)
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(sessionId)) throw new Error('Invalid OpenCode session identity')
  const marker = join(journal, `${createHash('sha256').update(sessionId).digest('hex')}.pending`), count = join(root, 'count.txt')
  await send("Use the Bash tool exactly once to run: printf 'once\\n' >> count.txt; sleep 45. After it finishes, say DONE. Do not run any other command.")
  await until(async () => { try { return (await readFile(count, 'utf8')).trim() === 'once' && await access(marker).then(() => true, () => false) } catch { return false } })
  console.log(JSON.stringify({ stage: 'action_started', markerPresent: true, sideEffectCount: 1 }))
  archiveAttempted = true; await request(`/api/sessions/${id}/archive`, 'POST'); archived = true
  if (!(await request(`/api/sessions/${id}`)).session?.metadata?.lifecycleState?.includes('archived')) throw new Error('Archive not confirmed')
  await access(marker)
  await exec(process.execPath, [recovery, '--journal-dir', journal, '--session-id', sessionId, '--confirm-reviewed'])
  if (await access(marker).then(() => true, () => false)) throw new Error('Reviewed marker remains')
  const resumed = await request(`/api/sessions/${id}/resume`, 'POST', {})
  if (resumed.type !== 'success' || resumed.sessionId !== id) throw new Error('Session identity changed during recovery')
  archived = false; archiveAttempted = false
  await turn('Repeat the PAC_RECOVERY_MEMORY marker I asked you to remember. Do not run tools or commands.', 'PAC_RECOVERY_MEMORY_68721')
  const lines = (await readFile(count, 'utf8')).trim().split(/\r?\n/)
  if (lines.length !== 1 || lines[0] !== 'once') throw new Error('The uncertain action was repeated')
  console.log(JSON.stringify({ stage: 'recovered', sameSession: true, recall: true, sideEffectCount: lines.length, automaticReplay: false }))
} finally {
  if (id && jwt && !archived && !archiveAttempted) try { await request(`/api/sessions/${id}/archive`, 'POST') } catch { console.error('Test session cleanup outcome is uncertain'); process.exitCode = 1 }
}
