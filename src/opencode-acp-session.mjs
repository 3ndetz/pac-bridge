import { Duplex } from 'node:stream'
import { createAcpPeer } from './acp-peer.mjs'
import { spawnContained, stopContained } from './spawn-contained.mjs'

// Opens a single PAC-bound session through the same ACP router used by HAPI.
// The caller must present permissions and updates to the originating user.
export async function openOpencodeAcpSession({ command, args, env, cwd, model, resumeSessionId, onPermission, onDiagnostic = () => {} }) {
  if (typeof command !== 'string' || !command || !Array.isArray(args) || typeof onPermission !== 'function') throw new Error('Invalid ACP launcher')
  const child = spawnContained(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  child.stderr.resume()
  child.on('error', () => {})
  let activeUpdate = null
  const delayed = []
  let delayedBytes = 0
  let id = resumeSessionId
  let loading = Boolean(resumeSessionId)
  let stopped = false
  let phase = 'initialize'
  const peer = createAcpPeer(Duplex.from({ readable: child.stdout, writable: child.stdin }), {
    onRequest: async (method, params) => {
      if (method !== 'session/request_permission' || !id || params?.sessionId !== id) throw new Error('Unsupported ACP client request')
      return onPermission(params)
    },
    onNotification: (method, params) => {
      // OpenCode already owns the visible conversation history. ACP load
      // replays it for synchronization; never replay its old tool actions.
      if (loading && method === 'session/update' && params?.sessionId === id &&
          ['user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update'].includes(params?.update?.sessionUpdate)) return
      // Native OpenCode advertises its own command list before session/new
      // returns. It is not a PAC command list and must not be attributed to it.
      if (!id && method === 'session/update' && params?.update?.sessionUpdate === 'available_commands_update') return
      const type = params?.update?.sessionUpdate
      const safeMethod = typeof method === 'string' && /^[a-z_/]{1,64}$/.test(method) ? method.replaceAll('/', 'Z') : 'other'
      try { onDiagnostic(`notification:${safeMethod}__${typeof type === 'string' && /^[a-z_]{1,64}$/.test(type) ? type : 'none'}`) } catch {}
      if ((params?.sessionId && params.sessionId !== id) || (params?.rootSessionId && params.rootSessionId !== id) ||
          (['opencode/session/child_update', 'pac/background_tasks_changed'].includes(method) && params?.rootSessionId !== id)) {
        onDiagnostic('bad_session'); throw new Error('ACP update belongs to another session')
      }
      if (!activeUpdate) {
        const metadata = method === '_auth/status_update' || method === 'opencode/session/child_update' || method === 'pac/background_tasks_changed' ||
          (method === 'session/update' && ['session_info_update', 'usage_update', 'available_commands_update'].includes(type))
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
    if (resumeSessionId && initialized.agentCapabilities?.loadSession !== true) throw new Error('ACP session cannot be restored')
    const opened = await peer.call(resumeSessionId ? 'session/load' : 'session/new', { cwd, mcpServers: [], ...(resumeSessionId ? { sessionId: resumeSessionId } : {}) })
    id = opened?.sessionId ?? resumeSessionId
    loading = false
    if (typeof id !== 'string' || !id) throw new Error('ACP session identity is missing')
    if (resumeSessionId && id !== resumeSessionId) throw new Error('ACP returned a different session identity')
    const option = opened.configOptions?.find((entry) => entry.id === 'model' || entry.category === 'model')
    const available = option?.options?.some((entry) => entry.value === model) || opened.models?.availableModels?.some((entry) => entry.modelId === model)
    if (!available) throw new Error('Selected PAC model is unavailable')
    async function selectModel(value) {
      if (option) {
        const selected = await peer.call('session/set_config_option', { sessionId: id, configId: option.id, value })
        const confirmed = selected?.configOptions?.find((entry) => entry.id === option.id)
        if (confirmed?.currentValue !== value) throw new Error('PAC model selection was not confirmed')
      } else {
        // The router returns only after the remote runtime confirms the model.
        await peer.call('session/set_model', { sessionId: id, modelId: value })
      }
    }
    phase = 'select-model'
    await selectModel(model)
    return {
      sourceSessionId: id,
      selectModel,
      async prompt(prompt, onUpdate) {
        if (stopped || activeUpdate) throw new Error('ACP session is unavailable or busy')
        activeUpdate = onUpdate
        try {
          while (delayed.length) { const item = delayed.shift(); delayedBytes -= item.bytes; activeUpdate(item.event) }
          const result = await peer.call('session/prompt', { sessionId: id, prompt }, 0)
          await peer.drainNotifications()
          return result
        }
        catch (error) { error.pacPhase = 'prompt'; throw error }
        finally { activeUpdate = null }
      },
      cancel() { if (!stopped) peer.notify('session/cancel', { sessionId: id }) },
      stopTask(taskId) {
        if (stopped) throw new Error('ACP session is unavailable')
        return peer.call('pac/tasks/stop', { sessionId: id, taskId })
      },
      close,
    }
  } catch (error) { error.pacPhase = phase; close(); throw error }
}
