import { randomUUID } from 'node:crypto'
import { access, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

// Opt-in real-model check; operates only on its own disposable HAPI chat.
const [workspace, model, ...extra] = process.argv.slice(2)
if (process.env.PAC_TEST_INSTALLED !== '1' || !workspace || !isAbsolute(workspace) || !model?.startsWith('PAC_') || extra.length) throw new Error('Pass an absolute test workspace and PAC model with PAC_TEST_INSTALLED=1')
const cwd = await realpath(workspace), profile = process.env.HAPI_HOME || join(homedir(), '.hapi-servermall')
const load = async name => JSON.parse((await readFile(join(profile, name), 'utf8')).replace(/^\uFEFF/, ''))
const settings = await load('settings.json'), connection = await load('connection.json')
if (!Number.isInteger(connection.relayPort) || connection.relayPort < 1 || connection.relayPort > 65535) throw new Error('Invalid relay port')
const base = `http://127.0.0.1:${connection.relayPort}`
let jwt, id
async function request(path, method = 'GET', body) {
  const response = await fetch(base + path, { method, headers: { ...(jwt ? { authorization: `Bearer ${jwt}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(150000) })
  if (!response.ok) throw Object.assign(new Error(`HAPI ${method} returned ${response.status}`), { status: response.status })
  return response.status === 204 ? {} : response.json()
}
async function until(fn, timeout = 150000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const result = await fn(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 1000)) }
  throw new Error('Timed out waiting for the background task verification')
}
async function send(text) {
  const body = { text, localId: randomUUID() }, end = Date.now() + 60000
  while (true) {
    try { return await request(`/api/sessions/${encodeURIComponent(id)}/messages`, 'POST', body) }
    catch (error) { if (error.status !== 409 || Date.now() >= end) throw error; await new Promise(resolve => setTimeout(resolve, 1000)) }
  }
}
const messages = async () => (await request(`/api/sessions/${encodeURIComponent(id)}/messages?limit=100`)).messages || []
const filename = `pac-stop-proof-${randomUUID()}.txt`
try {
  jwt = (await request('/api/auth', 'POST', { accessToken: settings.cliApiToken })).token
  const machine = (await request('/api/machines')).machines.find(item => item.active && item.id === settings.machineId)
  if (!jwt || !machine) throw new Error('Existing HAPI runner is unavailable')
  const created = await request(`/api/machines/${encodeURIComponent(machine.id)}/spawn`, 'POST', { directory: cwd, agent: 'opencode', model, yolo: true, startingMode: 'remote' })
  if (created.type !== 'success' || !created.sessionId) throw new Error('Could not create the disposable test chat')
  id = created.sessionId
  await send(`Use Bash with run_in_background=true to execute exactly: sleep 60; printf NOT_STOPPED > ${filename}. Return the background task ID immediately.`)
  const task = await until(async () => JSON.stringify(await messages()).match(/pac-shell-[0-9a-f-]{36}/)?.[0])
  const before = new Set((await messages()).map(message => message.id))
  await send(`/pac-stop ${task}`)
  await until(async () => (await messages()).some(message => !before.has(message.id) && /PAC (?:task stopped|stop request accepted)/.test(JSON.stringify(message))))
  await new Promise(resolve => setTimeout(resolve, 65000))
  if (await access(join(cwd, filename)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })) throw new Error('The stopped background command still wrote its file')
  console.log(JSON.stringify({ backgroundTask: true, stopConfirmed: true, delayedWritePrevented: true }))
} finally {
  if (id && jwt) {
    try { await request(`/api/sessions/${encodeURIComponent(id)}/archive`, 'POST') }
    catch { console.error('The verification chat could not be archived.'); process.exitCode = 1 }
  }
}
