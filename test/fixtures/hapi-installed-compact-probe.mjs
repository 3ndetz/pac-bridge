import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

// Explicit operator opt-in; only the session created here may be archived.
if (process.env.PAC_TEST_INSTALLED !== '1') throw new Error('Set PAC_TEST_INSTALLED=1 to run against the installed hub')
const settings = JSON.parse((await readFile(join(process.env.USERPROFILE, '.hapi-servermall', 'settings.json'), 'utf8')).replace(/^\uFEFF/, ''))
const connection = JSON.parse((await readFile(join(process.env.USERPROFILE, '.hapi-servermall', 'connection.json'), 'utf8')).replace(/^\uFEFF/, ''))
const base = `http://127.0.0.1:${connection.relayPort}`
const tempRoot = await realpath(join(process.env.USERPROFILE, 'AppData', 'Local', 'Temp'))
const root = await mkdtemp(join(tempRoot, 'pac-installed-proof-'))
let jwt, id
async function request(path, method = 'GET', data) {
  const response = await fetch(base + path, { method, headers: { ...(jwt ? { authorization: `Bearer ${jwt}` } : {}), ...(data ? { 'content-type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}), signal: AbortSignal.timeout(150000) })
  if (!response.ok) throw new Error(`HAPI ${method} ${path.split('?')[0]} returned ${response.status}`)
  return response.json()
}
async function until(fn, timeout = 120000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await new Promise((resolve) => setTimeout(resolve, 1000)) }
  throw new Error('Timed out waiting for the installed HAPI result')
}
const messages = async () => (await request(`/api/sessions/${id}/messages?limit=100`)).messages || []
const send = (text) => request(`/api/sessions/${id}/messages`, 'POST', { text, localId: randomUUID() })
try {
  jwt = (await request('/api/auth', 'POST', { accessToken: settings.cliApiToken })).token
  if (!jwt) throw new Error('HAPI authentication failed')
  const machine = (await request('/api/machines')).machines.find((item) => item.active && item.id === settings.machineId)
  if (!machine) throw new Error('The current machine runner was not found')
  const models = await request(`/api/machines/${machine.id}/opencode-models?cwd=${encodeURIComponent(root)}`)
  if (!JSON.stringify(models).includes('PAC_testpac/sonnet')) throw new Error('PAC model is missing from the installed runner')
  const created = await request(`/api/machines/${machine.id}/spawn`, 'POST', { directory: root, agent: 'opencode', model: 'PAC_testpac/sonnet', yolo: true, startingMode: 'remote' })
  if (created.type !== 'success' || !created.sessionId) throw new Error('Installed runner could not create the test session')
  id = created.sessionId
  await send('Remember the marker PAC_INSTALLED_COMPACT_73019. Reply READY.')
  await until(async () => (await messages()).some((m) => m.content?.role === 'agent' && m.content?.content?.data?.type === 'message' && /READY/.test(m.content.content.data.message || '')))
  const before = new Set((await messages()).map((m) => m.id))
  await send('/compact')
  await until(async () => (await messages()).some((m) => !before.has(m.id) && m.content?.content?.data?.type === 'compact-summary'), 180000)
  const previous = new Set((await messages()).map((m) => m.id))
  await send('Repeat only the exact marker I asked you to remember.')
  await until(async () => (await messages()).some((m) => !previous.has(m.id) && m.content?.content?.data?.type === 'message' && (m.content.content.data.message || '').includes('PAC_INSTALLED_COMPACT_73019')))
  console.log(JSON.stringify({ installedMachine: true, pacModel: true, compactConfirmed: true, markerRecalled: true }))
} finally {
  if (id && jwt) await request(`/api/sessions/${id}/archive`, 'POST').catch(() => {})
  if (dirname(root).toLowerCase() === tempRoot.toLowerCase() && basename(root).startsWith('pac-installed-proof-')) await rm(root, { recursive: true, force: true })
}
