import { randomUUID } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

// Creates and archives only its own disposable chat on the existing runner.
// It invokes a real PAC model and therefore requires explicit operator opt-in.
const [cwdArg, model, ...extra] = process.argv.slice(2)
if (process.env.PAC_TEST_INSTALLED !== '1' || !cwdArg || !isAbsolute(cwdArg) || !model || !model.startsWith('PAC_') || extra.length) {
  throw new Error('Set PAC_TEST_INSTALLED=1 and pass an absolute permitted workspace and a PAC model ID')
}
const root = await realpath(cwdArg)
const profileHome = process.env.HAPI_HOME || join(homedir(), '.hapi-servermall')
const settings = JSON.parse((await readFile(join(profileHome, 'settings.json'), 'utf8')).replace(/^\uFEFF/, ''))
const connection = JSON.parse((await readFile(join(profileHome, 'connection.json'), 'utf8')).replace(/^\uFEFF/, ''))
if (!Number.isInteger(connection.relayPort) || connection.relayPort < 1 || connection.relayPort > 65535) throw new Error('Invalid local relay port')
const base = `http://127.0.0.1:${connection.relayPort}`
let jwt, sessionId
async function request(path, method = 'GET', data) {
  const response = await fetch(base + path, { method, headers: { ...(jwt ? { authorization: `Bearer ${jwt}` } : {}), ...(data ? { 'content-type': 'application/json' } : {}) },
    ...(data ? { body: JSON.stringify(data) } : {}), signal: AbortSignal.timeout(150000) })
  if (!response.ok) throw Object.assign(new Error(`HAPI ${method} returned ${response.status}`), { status: response.status })
  return response.status === 204 ? {} : response.json()
}
async function until(fn, timeout = 150000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 1000)) }
  throw new Error('Timed out waiting for HAPI verification')
}
async function send(text) {
  const body = { text, localId: randomUUID() }, deadline = Date.now() + 60000
  while (true) {
    try { return await request(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, 'POST', body) }
    catch (error) { if (error.status !== 409 || Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 1000)) }
  }
}
const messages = async () => (await request(`/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=100`)).messages || []
const marker = `PAC_BRIDGE_PROOF_${randomUUID()}`
try {
  jwt = (await request('/api/auth', 'POST', { accessToken: settings.cliApiToken })).token
  if (!jwt) throw new Error('HAPI authentication failed')
  const machine = (await request('/api/machines')).machines.find(item => item.active && item.id === settings.machineId)
  if (!machine) throw new Error('The existing machine runner is unavailable')
  const models = await request(`/api/machines/${encodeURIComponent(machine.id)}/opencode-models?cwd=${encodeURIComponent(root)}`)
  if (!JSON.stringify(models).includes(model)) throw new Error('The requested PAC model was not discovered')
  const created = await request(`/api/machines/${encodeURIComponent(machine.id)}/spawn`, 'POST', { directory: root, agent: 'opencode', model, yolo: true, startingMode: 'remote' })
  if (created.type !== 'success' || !created.sessionId) throw new Error('HAPI did not create the verification chat')
  sessionId = created.sessionId
  await send(`Remember the marker ${marker}. Reply READY.`)
  await until(async () => (await messages()).some(m => m.content?.role === 'agent' && m.content?.content?.data?.type === 'message' && /READY/.test(m.content.content.data.message || '')))
  const before = new Set((await messages()).map(m => m.id))
  await send('/compact')
  await until(async () => (await messages()).some(m => !before.has(m.id) && m.content?.content?.data?.type === 'compact-summary'), 180000)
  const after = new Set((await messages()).map(m => m.id))
  await send('Repeat only the exact marker I asked you to remember.')
  await until(async () => (await messages()).some(m => !after.has(m.id) && m.content?.role === 'agent' && m.content?.content?.data?.type === 'message' && (m.content.content.data.message || '').includes(marker)))
  console.log(JSON.stringify({ runner: true, model: true, compact: true, recall: true }))
} finally {
  if (sessionId && jwt) {
    try { await request(`/api/sessions/${encodeURIComponent(sessionId)}/archive`, 'POST') }
    catch { console.error('The verification chat could not be archived; inspect it before retrying.'); process.exitCode = 1 }
  }
}
