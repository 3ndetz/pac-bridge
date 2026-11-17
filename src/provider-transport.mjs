import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Deployment metadata for new HAPI children only. Existing processes keep their
// transport; no runner restart or source-harness configuration discovery occurs.
export function providerRelayOverride(pointer, revision) {
  if (!Object.hasOwn(pointer, 'relayUrl')) return undefined
  if (!/^[0-9a-f]{40}$/.test(revision) || pointer.revision !== revision || typeof pointer.relayUrl !== 'string') throw new Error('PAC transport revision mismatch')
  let url
  try { url = new URL(pointer.relayUrl) } catch { throw new Error('Invalid PAC deployment relay URL') }
  if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Invalid PAC deployment relay URL')
  return url.href
}

export async function applyProviderRelayOverride({ entryUrl, env = process.env }) {
  if (env.PAC_HAPI_PROVIDER_EXPERIMENT !== '1') return
  const home = (process.platform === 'win32' ? env.USERPROFILE || env.HOME : env.HOME) || homedir()
  const path = join(home, '.hapi-servermall', 'pac-bridge', 'provider-current.json')
  let file
  try {
    const before = await lstat(path)
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 4096) throw new Error('Invalid PAC deployment pointer')
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    const actual = await file.stat()
    if (!actual.isFile() || actual.nlink !== 1 || actual.dev !== before.dev || actual.ino !== before.ino || actual.size > 4096) throw new Error('PAC deployment pointer changed')
    const bytes = Buffer.alloc(4097)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    if (bytesRead > 4096) throw new Error('Invalid PAC deployment pointer')
    const pointer = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead)).replace(/^\uFEFF/, ''))
    if (!pointer || typeof pointer !== 'object' || Array.isArray(pointer)) throw new Error('Invalid PAC deployment pointer')
    const relayUrl = providerRelayOverride(pointer, basename(dirname(dirname(fileURLToPath(entryUrl)))))
    if (relayUrl !== undefined) {
      // A multi-PAC catalogue has its own endpoint addresses. Never pretend that
      // changing the single-PAC endpoint moved those connections too.
      if (env.PAC_ENDPOINTS_FILE) throw new Error('PAC deployment relay override requires a single PAC endpoint')
      env.PAC_RELAY_URL = relayUrl
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  finally { await file?.close() }
}
