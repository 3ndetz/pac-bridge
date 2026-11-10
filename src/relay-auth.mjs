import { createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'

const namePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const hashPattern = /^[0-9a-f]{64}$/

// Re-read for every handshake: removing a hash revokes new connections without
// restarting the relay. Existing sessions are closed on process restart.
export function createRelayAuthorizer(path) {
  if (typeof path !== 'string' || !path) throw new Error('Relay authorization file is required')
  return ({ role, name, token }) => {
    if (!['register', 'agent', 'source'].includes(role) || typeof name !== 'string' || !namePattern.test(name) ||
        typeof token !== 'string' || !token || Buffer.byteLength(token) > 4096) return false
    try {
      const raw = readFileSync(path)
      if (raw.length > 1024 * 1024) return false
      const config = JSON.parse(raw.toString('utf8'))
      const entry = config?.pacs?.[name]
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
      const hashes = role === 'source' ? entry.sourceHashes : entry.agentHashes
      if (!Array.isArray(hashes) || hashes.length > 64 || hashes.some((hash) => typeof hash !== 'string' || !hashPattern.test(hash))) return false
      const actual = createHash('sha256').update(token).digest()
      let authorized = false
      for (const hash of hashes) authorized = timingSafeEqual(actual, Buffer.from(hash, 'hex')) || authorized
      return authorized
    } catch { return false }
  }
}
