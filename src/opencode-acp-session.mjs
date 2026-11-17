import { Duplex } from 'node:stream'
import { createAcpPeer } from './acp-peer.mjs'
import { spawnContained, stopContained } from './spawn-contained.mjs'
import { normalizePacBackgroundTasks } from './pac-background-tasks.mjs'

// Opens a single PAC-bound session through the same ACP router used by HAPI.
// The caller must present permissions and updates to the originating user.
export async function openOpencodeAcpSession({ command, args, env, cwd, model, resumeSessionId, onPermission, onDiagnostic = () => {}, onIdleBackgroundTasks, onBackgroundAvailability, signal }) {
  if (typeof command !== 'string' || !command || !Array.isArray(args) || typeof onPermission !== 'function' || (onIdleBackgroundTasks !== undefined && typeof onIdleBackgroundTasks !== 'function') || (onBackgroundAvailability !== undefined && typeof onBackgroundAvailability !== 'function')) throw new Error('Invalid ACP launcher')
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Error('Invalid ACP cancellation signal')
  if (signal?.aborted) throw new Error('ACP opening was cancelled before it started')
  const child = spawnContained(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  child.stderr.resume()
  child.on('error', () => {})
  let activeUpdate = null
  const delayed = []
  let delayedBytes = 0
  let id = resumeSessionId
  let loading = Boolean(resumeSessionId)
  let stopped = false
  let availabilityEpoch = null, availabilityReady = false, availabilityRevision = 0, availabilityClosed = false, availabilitySnapshotPending = false
  function parseAvailability(value) {
    if (!value || value.rootSessionId !== id || typeof value.epoch !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.epoch) || !['unknown', 'ready'].includes(value.availability) || (value.availability === 'unknown' && value.tasks !== undefined)) throw new Error('Invalid PAC background availability')
    return { rootSessionId: id, epoch: value.epoch, availability: value.availability, ...(value.availability === 'ready' ? { tasks: normalizePacBackgroundTasks(value.tasks) } : {}) }
  }
  function invalidateAvailability() {
    if (availabilityClosed) return
    availabilityClosed = true
    availabilityReady = false
    availabilityRevision++
    if (id && onBackgroundAvailability) {
      try { onBackgroundAvailability({ rootSessionId: id, epoch: availabilityEpoch, availability: 'unknown' }) } catch {}
    }
  }
  child.once('exit', invalidateAvailability)
  let phase = 'initialize'
  let phaseStarted = performance.now()
  function nextPhase(next) {
    const elapsed = Math.max(0, Math.round(performance.now() - phaseStarted))
    try { onDiagnostic(`startup:${phase}:${elapsed}ms`) } catch {}
    phase = next
    phaseStarted = performance.now()
  }
  const transport = Duplex.from({ readable: child.stdout, writable: child.stdin })
  transport.once('end', invalidateAvailability)
  transport.once('close', invalidateAvailability)
  transport.once('error', invalidateAvailability)
  const peer = createAcpPeer(transport, {
    onRequest: async (method, params) => {
      if (method !== 'session/request_permission' || !id || params?.sessionId !== id) throw new Error('Unsupported ACP client request')
      return onPermission(params)
    },
    onNotification: (method, params) => {
      // OpenCode already owns the visible conversation history. ACP load
      // replays it for synchronization; never replay its old tool actions.
      if (loading && method === 'session/update' && params?.sessionId === id &&
          ['user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'compaction_update'].includes(params?.update?.sessionUpdate)) return
      // Native OpenCode advertises its own command list before session/new
      // returns. It is not a PAC command list and must not be attributed to it.
      if (!id && method === 'session/update' && params?.update?.sessionUpdate === 'available_commands_update') return
      const type = params?.update?.sessionUpdate
      const safeMethod = typeof method === 'string' && /^[a-z_/]{1,64}$/.test(method) ? method.replaceAll('/', 'Z') : 'other'
      try { onDiagnostic(`notification:${safeMethod}__${typeof type === 'string' && /^[a-z_]{1,64}$/.test(type) ? type : 'none'}`) } catch {}
      if ((params?.sessionId && params.sessionId !== id) || (params?.rootSessionId && params.rootSessionId !== id) ||
          (['opencode/session/child_update', 'pac/background_tasks_changed', 'pac/background_availability'].includes(method) && params?.rootSessionId !== id)) {
        onDiagnostic('bad_session'); throw new Error('ACP update belongs to another session')
      }
      if (method === 'pac/background_availability' && onBackgroundAvailability) {
        const value = parseAvailability(params)
        availabilityRevision++
        if (availabilityEpoch !== value.epoch) availabilityReady = false
        availabilityEpoch = value.epoch
        if (value.availability === 'unknown') availabilityReady = false
        onBackgroundAvailability(value.availability === 'ready' && !availabilityReady ? { rootSessionId: id, epoch: value.epoch, availability: 'unknown' } : value)
        return
      }
      if (!activeUpdate) {
        if (method === 'pac/background_tasks_changed' && onIdleBackgroundTasks) {
          onIdleBackgroundTasks({ rootSessionId: id, tasks: normalizePacBackgroundTasks(params.tasks) })
          return
        }
        const metadata = method === '_auth/status_update' || method === 'opencode/session/child_update' || method === 'pac/background_tasks_changed' ||
          (method === 'session/update' && ['session_info_update', 'usage_update', 'available_commands_update'].includes(type))
        const bytes = Buffer.byteLength(JSON.stringify({ method, params }))
        if (!metadata || delayed.length >= 64 || delayedBytes + bytes > 1024 * 1024) {
          onDiagnostic(`no_active_turn:${safeMethod}__${typeof type === 'string' && /^[a-z_]{1,64}$/.test(type) ? type : 'none'}`)
          throw new Error('ACP update cannot be delivered outside an active turn')
        }
        delayed.push({ event: { method, params }, bytes })
        delayedBytes += bytes
        return
      }
      try { activeUpdate({ method, params }) } catch (error) { onDiagnostic('consumer_error'); throw error }
    },
  })
  function close() {
    signal?.removeEventListener('abort', abortOpening)
    if (!stopped) {
      stopped = true
      invalidateAvailability()
      peer.close()
    }
    // Retry a failed owned-handle stop when the owner calls close again.
    stopContained(child)
  }
  function abortOpening() {
    try { close() } catch { try { onDiagnostic('cleanup_failed') } catch {} }
  }
  signal?.addEventListener('abort', abortOpening, { once: true })
  try {
    const initialized = await peer.call('initialize', { protocolVersion: 1, clientCapabilities: {} })
    if (initialized?.protocolVersion !== 1) throw new Error('Unsupported ACP version')
    nextPhase('session-new')
    if (resumeSessionId && initialized.agentCapabilities?.loadSession !== true) throw new Error('ACP session cannot be restored')
    const opened = await peer.call(resumeSessionId ? 'session/load' : 'session/new', { cwd, mcpServers: [], ...(resumeSessionId ? { sessionId: resumeSessionId } : {}) })
    id = opened?.sessionId ?? resumeSessionId
    // The load response can arrive before queued historical notifications
    // finish running. Keep replay suppression active until they have drained.
    if (loading) await peer.drainNotifications()
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
    nextPhase('select-model')
    await selectModel(model)
    nextPhase('ready')
    return {
      sourceSessionId: id,
      selectModel,
      async requestBackgroundSnapshot() {
        if (stopped || availabilityClosed || availabilitySnapshotPending) throw new Error('ACP session is unavailable or snapshot is pending')
        availabilitySnapshotPending = true
        try {
          const revision = availabilityRevision
          const result = parseAvailability(await peer.call('pac/background_tasks/snapshot', { sessionId: id }, 5000))
          await peer.drainNotifications()
          if (availabilityClosed || availabilityRevision !== revision) throw new Error('PAC background availability changed during snapshot')
          availabilityEpoch = result.epoch
          availabilityReady = result.availability === 'ready'
          return result
        } catch (error) {
          availabilityReady = false
          availabilityRevision++
          if (!availabilityClosed && onBackgroundAvailability) {
            try { onBackgroundAvailability({ rootSessionId: id, epoch: availabilityEpoch, availability: 'unknown' }) } catch {}
          }
          throw error
        } finally { availabilitySnapshotPending = false }
      },
      async prompt(prompt, onUpdate) {
        if (stopped || activeUpdate) throw new Error('ACP session is unavailable or busy')
        activeUpdate = onUpdate
        try {
          while (delayed.length) { const item = delayed.shift(); delayedBytes -= item.bytes; activeUpdate(item.event) }
          const result = await peer.call('session/prompt', { sessionId: id, prompt }, 0)
          await peer.drainNotifications()
          return result
        }
        catch (error) {
          if (env?.PAC_DIAGNOSTICS === '1') {
            const detail = [error?.message, error?.rpc?.data?.details].filter(value => typeof value === 'string').join(' ')
            const category = [
              ['settings_unsupported', 'does not support source Claude settings'],
              ['settings_unconfirmed', 'cannot confirm source Claude settings'],
              ['settings_changed', 'Source Claude settings changed'],
              ['source_setup', 'source_setup_failed'],
              ['authentication', 'Authentication required'],
              ['model_unavailable', 'Selected PAC model is unavailable'],
              ['disconnected', 'ACP connection lost'],
              ['timeout', 'ACP request timed out'],
            ].find(([, value]) => detail.includes(value))?.[0] || 'other'
            try { onDiagnostic(`prompt_failure:${category}`) } catch {}
          }
          error.pacPhase = 'prompt'; throw error
        }
        finally { activeUpdate = null }
      },
      cancel() { if (!stopped) peer.notify('session/cancel', { sessionId: id }) },
      compact() {
        if (stopped || activeUpdate) throw new Error('ACP session is unavailable or busy')
        return peer.call('pac/compact', { sessionId: id }, 0)
      },
      stopTask(taskId) {
        if (stopped) throw new Error('ACP session is unavailable')
        return peer.call('pac/tasks/stop', { sessionId: id, taskId })
      },
      close,
    }
  } catch (error) { error.pacPhase = phase; nextPhase('failed'); close(); throw error }
}
