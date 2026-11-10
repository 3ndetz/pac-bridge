import { Duplex } from 'node:stream'
import { createAcpPeer } from './acp-peer.mjs'
import { spawnContained, stopContained } from './spawn-contained.mjs'

// Opens a single PAC-bound session through the same ACP router used by HAPI.
// The caller must present permissions and updates to the originating user.
export async function openOpencodeAcpSession({ command, args, env, cwd, model, onPermission }) {
  if (typeof command !== 'string' || !command || !Array.isArray(args) || typeof onPermission !== 'function') throw new Error('Invalid ACP launcher')
  const child = spawnContained(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  child.stderr.resume()
  child.on('error', () => {})
  let activeUpdate = null
  let id
  let stopped = false
  const peer = createAcpPeer(Duplex.from({ readable: child.stdout, writable: child.stdin }), {
    onRequest: async (method, params) => {
      if (method !== 'session/request_permission' || !id || params?.sessionId !== id) throw new Error('Unsupported ACP client request')
      return onPermission(params)
    },
    onNotification: (method, params) => {
      if (params?.sessionId && params.sessionId !== id) throw new Error('ACP update belongs to another session')
      if (!activeUpdate) throw new Error('ACP update cannot be delivered outside an active turn')
      activeUpdate({ method, params })
    },
  })
  function close() {
    if (stopped) return
    stopped = true
    peer.close()
    stopContained(child)
  }
  try {
    const initialized = await peer.call('initialize', { protocolVersion: 1, clientCapabilities: {} })
    if (initialized?.protocolVersion !== 1) throw new Error('Unsupported ACP version')
    const opened = await peer.call('session/new', { cwd, mcpServers: [] })
    id = opened?.sessionId
    if (typeof id !== 'string' || !id) throw new Error('ACP session identity is missing')
    const option = opened.configOptions?.find((entry) => entry.id === 'model' || entry.category === 'model')
    if (!option?.options?.some((entry) => entry.value === model)) throw new Error('Selected PAC model is unavailable')
    const selected = await peer.call('session/set_config_option', { sessionId: id, configId: option.id, value: model })
    const confirmed = selected?.configOptions?.find((entry) => entry.id === option.id)
    if (confirmed?.currentValue !== model) throw new Error('PAC model selection was not confirmed')
    return {
      async prompt(prompt, onUpdate) {
        if (stopped || activeUpdate) throw new Error('ACP session is unavailable or busy')
        activeUpdate = onUpdate
        try { return await peer.call('session/prompt', { sessionId: id, prompt }, 0) }
        finally { activeUpdate = null }
      },
      cancel() { if (!stopped) peer.notify('session/cancel', { sessionId: id }) },
      close,
    }
  } catch (error) { close(); throw error }
}
