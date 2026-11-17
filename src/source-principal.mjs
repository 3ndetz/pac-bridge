import { createHash } from 'node:crypto'
const namePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const hashPattern = /^[0-9a-f]{64}$/

// This is an identity derived by the authenticated relay, not an identity
// accepted from source-controlled ACP parameters or HTTP headers.
export function sourcePrincipal(pacName, credentialHash, sourceId) {
  if (typeof pacName !== 'string' || !namePattern.test(pacName) ||
      typeof credentialHash !== 'string' || !hashPattern.test(credentialHash) ||
      (sourceId !== undefined && (typeof sourceId !== 'string' || !namePattern.test(sourceId)))) throw new Error('Invalid source identity')
  const scope = sourceId === undefined ? `token:${credentialHash}` : `id:${sourceId}`
  return createHash('sha256').update(`pac-source-v1\0${pacName}\0${scope}`).digest('hex')
}
