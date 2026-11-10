import { Duplex } from 'node:stream'
import { createAcpPeer } from './acp-peer.mjs'
import { spawnContained, stopContained } from './spawn-contained.mjs'

// Opens a single PAC-bound session through the same ACP router used by HAPI.
// The caller must present permissions and updates to the originating user.
export async function openOpencodeAcpSession({ command, args, env, cwd, model, onPermission, onDiagnostic = () => {} }) {
  if (typeof command !== 'string' || !command || !Array.isArray(args) || typeof onPermission !== 'function') throw new Error('Invalid ACP launcher')
  const child = spawnContained(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  child.stderr.resume()
  child.on('error', () => {})
  let activeUpdate = null
  const delayed = []
  let delayedBytes = 0
  let id
  let stopped = false
  let phase = 'initialize'
  const peer = createAcpPeer(Duplex.from({ readable: child.stdout, writable: child.stdin }), {
    onRequest: async (method, params) => {
      if (method !== 'session/request_permission' || !id || params?.sessionId !== id) throw new Error('Unsupported ACP client request')
      return onPermission(params)
    },
    onNotification: (method, params) => {
      // Native OpenCode advertises its own command list before session/new
      // returns. It is not a PAC command list and must not be attributed to it.
      if (!id && method === 'session/update' && params?.update?.sessionUpdate === 'available_commands_update') return
      const type = params?.update?.sessionUpdate
      const safeMethod = typeof method === 'string' && /^[a-z_/]{1,64}$/.test(method) ? method.replaceAll('/', 'Z') : 'other'
      try { onDiagnostic(`notification:${safeMethod}__${typeof type === 'string' && /^[a-z_]{1,64}$/.test(type) ? type : 'none'}`) } catch {}
      if (params?.sessionId && params.sessionId !== id) { onDiagnostic('bad_session'); throw new Error('ACP update belongs to another session') }
      if (!activeUpdate) {
        const metadata = method === '_auth/status_update' || (method === 'session/update' && ['session_info_update', 'usage_update', 'available_commands_update'].includes(type))
        const bytes = Buffer.byteLength(JSON.stringify({ method, params }))
        if (!metadata || delayed.length >= 64 || delayedBytes + bytes > 1024 * 1024) { onDiagnostic('no_active_turn'); throw new Error('ACP update cannot be delivered outside an active turn') }
        delayed.push({ event: { method, params }, bytes })
        delayedBytes += bytes
        return
      }
      try { activeUpdate({ method, params }) } catch (error) { onDiagnostic('consumer_error'); throw error }
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
    phase = 'session-new'
    const opened = await peer.call('session/new', { cwd, mcpServers: [] })
    id = opened?.sessionId
    if (typeof id !== 'string' || !id) throw new Error('ACP session identity is missing')
    const option = opened.configOptions?.find((entry) => entry.id === 'model' || entry.category === 'model')
    const available = option?.options?.some((entry) => entry.value === model) || opened.models?.availableModels?.some((entry) => entry.modelId === model)
    if (!available) throw new Error('Selected PAC model is unavailable')
    phase = 'select-model'
    if (option) {
      const selected = await peer.call('session/set_config_option', { sessionId: id, configId: option.id, value: model })
      const confirmed = selected?.configOptions?.find((entry) => entry.id === option.id)
      if (confirmed?.currentValue !== model) throw new Error('PAC model selection was not confirmed')
    } else {
      // The router's legacy method returns only after the remote runtime has
      // confirmed the selected model; its ACP response itself is empty.
      await peer.call('session/set_model', { sessionId: id, modelId: model })
    }
    return {
      async prompt(prompt, onUpdate) {
        if (stopped || activeUpdate) throw new Error('ACP session is unavailable or busy')
        activeUpdate = onUpdate
        try {
          while (delayed.length) { const item = delayed.shift(); delayedBytes -= item.bytes; activeUpdate(item.event) }
          return await peer.call('session/prompt', { sessionId: id, prompt }, 0)
        }
        catch (error) { error.pacPhase = 'prompt'; throw error }
        finally { activeUpdate = null }
      },
      cancel() { if (!stopped) peer.notify('session/cancel', { sessionId: id }) },
      close,
    }
  } catch (error) { error.pacPhase = phase; close(); throw error }
}
