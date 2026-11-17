import { RequestError } from '@agentclientprotocol/sdk'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

const principalPattern = /^[0-9a-f]{64}$/
const denied = () => new RequestError(-32001, 'PAC session access denied')
function validSession(value) { return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\x00-\x1f\x7f]/.test(value) }

// The directory and its parents belong to the trusted controller OS account.
// Records are write-once. An interrupted or malformed claim fails closed; it is
// never repaired or reassigned in response to a remote session ID.
export function createSessionOwnershipStore(directory) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw new Error('An absolute ownership directory is required')
  function filename(id) {
    if (!validSession(id)) throw denied()
    return join(directory, `${createHash('sha256').update(id).digest('hex')}.json`)
  }
  async function checkDirectory(create) {
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 })
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw denied()
  }
  async function owner(id) {
    const path = filename(id)
    let file
    try {
      await checkDirectory(false)
      if ((await lstat(path)).isSymbolicLink()) throw denied()
      file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
      const stat = await file.stat()
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096) throw denied()
      const bytes = Buffer.alloc(4097)
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
      if (bytesRead > 4096) throw denied()
      const record = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'))
      if (record?.version !== 1 || record.sessionId !== id || typeof record.principal !== 'string' || !principalPattern.test(record.principal)) throw denied()
      return record.principal
    } catch (error) { if (error.code === 'ENOENT') return null; throw denied() }
    finally { await file?.close() }
  }
  return {
    owner,
    async claim(id, principal) {
      if (typeof principal !== 'string' || !principalPattern.test(principal)) throw denied()
      const path = filename(id)
      let file
      try {
        await checkDirectory(true)
        file = await open(path, 'wx', 0o600)
        await file.writeFile(JSON.stringify({ version: 1, sessionId: id, principal }), 'utf8')
        await file.sync()
      } catch (error) {
        if (error.code === 'EEXIST' && await owner(id) === principal) return
        throw denied()
      } finally { await file?.close() }
    },
  }
}

export function createSessionOwnership({ principal, store }) {
  function identity() { if (typeof principal !== 'string' || !principalPattern.test(principal)) throw denied(); return principal }
  return {
    async assert(id) { const trusted = identity(); if (!validSession(id) || await store.owner(id) !== trusted) throw denied() },
    async claim(id) { const trusted = identity(); if (!validSession(id)) throw denied(); await store.claim(id, trusted) },
    async permits(id) { identity(); return validSession(id) && await store.owner(id) === principal },
    requireIdentity: identity,
  }
}

// Install after the PAC source-tool wrappers. Never fall through to the SDK's
// unwrapped load/resume/fork paths, which can read controller-wide transcripts.
function rejectIdentityOptions(params) {
  const options = params?._meta?.claudeCode?.options
  if (['resume', 'continue', 'forkSession', 'sessionId', 'resumeSessionAt', 'resumeDropsTurn'].some(key => options && Object.hasOwn(options, key))) throw denied()
}

export function enforceSessionOwnership(agent, ownership) {
  const create = agent.newSession.bind(agent)
  const close = typeof agent.closeSession === 'function' ? agent.closeSession.bind(agent) : undefined
  agent.newSession = async (params) => {
    ownership.requireIdentity()
    rejectIdentityOptions(params)
    const result = await create(params)
    try { await ownership.claim(result?.sessionId) }
    catch (error) {
      if (close && validSession(result?.sessionId)) {
        try { await close({ sessionId: result.sessionId }) }
        catch { throw new RequestError(-32001, 'PAC session ownership failed; session cleanup is unconfirmed') }
      }
      throw error
    }
    return result
  }
  for (const method of ['loadSession', 'resumeSession', 'prompt', 'steer', 'goal', 'stopAsyncTask', 'cancel', 'closeSession', 'deleteSession', 'setSessionMode', 'setSessionConfigOption']) {
    if (typeof agent[method] !== 'function') continue
    const original = agent[method].bind(agent)
    agent[method] = async (params) => { await ownership.assert(params?.sessionId); rejectIdentityOptions(params); return original(params) }
  }
  if (typeof agent.unstable_forkSession === 'function') {
    const fork = agent.unstable_forkSession.bind(agent)
    agent.unstable_forkSession = async (params) => {
      await ownership.assert(params?.sessionId)
      rejectIdentityOptions(params)
      const result = await fork(params)
      await ownership.claim(result?.sessionId)
      return result
    }
  }
  if (typeof agent.listSessions === 'function') {
    const list = agent.listSessions.bind(agent)
    agent.listSessions = async (params) => {
      ownership.requireIdentity()
      const result = await list(params)
      const sessions = []
      for (const session of result.sessions) if (await ownership.permits(session.sessionId)) sessions.push(session)
      return { ...result, sessions }
    }
  }
}
