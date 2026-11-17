import { createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { sourcePrincipal } from './source-principal.mjs'

const namePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const hashPattern = /^[0-9a-f]{64}$/

// Re-read for every handshake: removing a hash revokes new connections without
// restarting the relay. Existing sessions are closed on process restart.
export function createRelayAuthorizer(path) {
  if (typeof path !== 'string' || !path) throw new Error('Relay authorization file is required')
  const context = ({ role, name, token }) => {
    if (!['register', 'agent', 'source'].includes(role) || typeof name !== 'string' || !namePattern.test(name) ||
        typeof token !== 'string' || !token || Buffer.byteLength(token) > 4096) return null
    try {
      const raw = readFileSync(path)
      if (raw.length > 1024 * 1024) return null
      const config = JSON.parse(raw.toString('utf8'))
      const entry = config?.pacs?.[name]
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
      const hashes = role === 'source' ? entry.sourceHashes : entry.agentHashes
      if (!Array.isArray(hashes) || hashes.length > 64 || hashes.some((hash) => typeof hash !== 'string' || !hashPattern.test(hash))) return null
      const actual = createHash('sha256').update(token).digest()
      let authorized = false
      for (const hash of hashes) authorized = timingSafeEqual(actual, Buffer.from(hash, 'hex')) || authorized
      if (!authorized) return null
      if (role !== 'source') return { allowed: true }
      const ids = entry.sourceIds
      if (ids !== undefined && (!ids || typeof ids !== 'object' || Array.isArray(ids) ||
          Object.entries(ids).some(([hash, id]) => !hashPattern.test(hash) || !hashes.includes(hash) || typeof id !== 'string' || !namePattern.test(id)))) return null
      const actualHash = actual.toString('hex')
      return { allowed: true, sourcePrincipal: sourcePrincipal(name, actualHash, ids?.[actualHash]) }
    } catch { return null }
  }
  const authorize = (request) => context(request)?.allowed === true
  authorize.context = context
  return authorize
}
