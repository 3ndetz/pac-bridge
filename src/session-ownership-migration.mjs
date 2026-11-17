import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { createSessionOwnershipStore } from './session-ownership.mjs'

// Operator-only input, never an ACP endpoint. Evidence must come from retained
// source binding records and backups, not a remote caller's knowledge of an ID.
export async function planSessionOwnershipMigration({ manifest, directory, store = createSessionOwnershipStore(directory) }) {
  if (typeof directory !== 'string' || !isAbsolute(directory) || !manifest || manifest.version !== 1 ||
      !Array.isArray(manifest.bindings) || manifest.bindings.length < 1 || manifest.bindings.length > 10000) throw new Error('Invalid ownership migration manifest')
  const bindings = [], seen = new Set()
  for (const row of manifest.bindings) {
    if (!row || typeof row.sessionId !== 'string' || !row.sessionId || row.sessionId.length > 1024 || /[\x00-\x1f\x7f]/.test(row.sessionId) ||
        typeof row.principal !== 'string' || !/^[0-9a-f]{64}$/.test(row.principal) || typeof row.evidence !== 'string' || !row.evidence.trim() || row.evidence.length > 2048 ||
        seen.has(row.sessionId)) throw new Error('Invalid ownership migration manifest')
    seen.add(row.sessionId)
    bindings.push({ sessionId: row.sessionId, principal: row.principal, evidence: row.evidence })
  }
  bindings.sort((a, b) => a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0)
  const planHash = createHash('sha256').update(JSON.stringify({ version: 1, directory: resolve(directory), bindings })).digest('hex')
  async function inspect() {
    let alreadyBound = 0
    for (const row of bindings) {
      const owner = await store.owner(row.sessionId)
      if (owner !== null && owner !== row.principal) throw new Error('Ownership migration conflicts with an existing binding')
      if (owner === row.principal) alreadyBound++
    }
    return alreadyBound
  }
  const alreadyBound = await inspect()
  return {
    planHash, total: bindings.length, alreadyBound, pending: bindings.length - alreadyBound,
    async apply(expectedHash) {
      if (expectedHash !== planHash) throw new Error('Ownership migration plan fingerprint mismatch')
      await inspect()
      for (const row of bindings) await store.claim(row.sessionId, row.principal)
      return { total: bindings.length, bound: bindings.length }
    },
  }
}
