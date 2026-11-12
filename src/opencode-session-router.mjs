// Maps OpenCode session identities to dedicated ACP sessions. The caller owns
// the transport and translates the updates and permission requests it receives.
export function createOpencodeSessionRouter({ openSession, store, journal, legacyStore }) {
  if (typeof openSession !== 'function') throw new Error('openSession is required')
  const sessions = new Map()
  let closed = false

  const samePac = (first, second) => first.startsWith('PAC_') && second.startsWith('PAC_') &&
    first.includes('/') && first.slice(0, first.indexOf('/')) === second.slice(0, second.indexOf('/'))

  function identity(value, label) {
    if (typeof value !== 'string' || !value || value.length > 512 || /[\x00-\x1f]/.test(value)) throw new Error(`Invalid ${label}`)
    return value
  }

  async function getSession({ sessionId, model, cwd }, mustResume) {
    identity(sessionId, 'OpenCode session identity')
    identity(model, 'PAC model')
    identity(cwd, 'workspace')
    if (closed) throw new Error('Session router is closed')
    if (await journal?.isPending(sessionId)) throw new Error('Previous PAC turn outcome is unknown; reconciliation is required')
    let state = sessions.get(sessionId)
    if (state) {
      if (!samePac(state.model, model) || state.cwd !== cwd) throw new Error('PAC model or workspace changed; start a new session')
    } else {
      state = { model, cwd, busy: false, lost: false, opening: null, session: null }
      sessions.set(sessionId, state)
      state.opening = Promise.resolve().then(async () => {
        const saved = await store?.read(sessionId)
        // Older ACP-routed turns may not exist in OpenCode's native message
        // history, so a legacy binding must be considered even for the first
        // provider request. The store is supplied only by the opt-in migration.
        const legacy = !saved ? await legacyStore?.read(sessionId) : null
        if (saved && (!['opencode-acp', 'opencode-legacy-acp'].includes(saved.pacId) || !samePac(saved.model, model) || saved.workspace !== cwd)) throw new Error('Saved PAC binding does not match the selected model or workspace')
        if (legacy && (legacy.workspace !== cwd || !samePac(`PAC_${legacy.pacId}/${legacy.model}`, model))) throw new Error('Legacy PAC binding does not match the selected model or workspace')
        if (mustResume && !saved && !legacy) throw new Error('PAC session binding is unavailable; refusing to start a different conversation')
        if (saved) state.model = saved.model
        if (legacy) state.model = `PAC_${legacy.pacId}/${legacy.model}`
        state.pacId = saved?.pacId || (legacy ? 'opencode-legacy-acp' : 'opencode-acp')
        const session = await openSession({ sessionId, model: state.model, cwd,
          ...(saved ? { resumeSessionId: saved.remoteSessionId } : legacy ? { resumeSessionId: legacy.sessionId, legacyBinding: legacy } : {}),
          ...(state.pacId === 'opencode-legacy-acp' ? { legacyMode: true } : {}) })
        if (!session || typeof session.prompt !== 'function' || typeof session.cancel !== 'function' || typeof session.close !== 'function') throw new Error('Invalid ACP session')
        state.session = session
        if (closed) { session.close(); throw new Error('Session router is closed') }
        if (store && !saved) {
          if (typeof session.sourceSessionId !== 'string' || !session.sourceSessionId) { session.close(); throw new Error('ACP session identity cannot be persisted') }
          try { await store.write({ version: 1, sessionId, pacId: state.pacId, remoteSessionId: session.sourceSessionId, model: state.model, workspace: cwd }) }
          catch (error) { session.close(); throw error }
        }
        return session
      }).catch((error) => {
        // A failed open can have created a remote session. Never silently retry it.
        state.lost = true
        throw error
      })
    }
    if (state.lost) throw new Error('PAC session state is uncertain; start a new session')
    const session = await state.opening
    if (state.lost) throw new Error('PAC session state is uncertain; start a new session')
    return { state, session }
  }

  return {
    hasSession(sessionId) { return sessions.has(sessionId) },
    async canResume(sessionId) {
      if (await journal?.isPending(sessionId)) throw new Error('Previous PAC turn outcome is unknown; reconciliation is required')
      return Boolean(await store?.read(sessionId) || await legacyStore?.read(sessionId))
    },
    async prompt(binding, prompt, onUpdate, { signal, mustResume = false } = {}) {
      if (!Array.isArray(prompt) || typeof onUpdate !== 'function') throw new Error('Invalid PAC prompt')
      if (signal?.aborted) throw new Error('PAC turn was cancelled before it started')
      const { state, session } = await getSession(binding, mustResume)
      if (signal?.aborted) throw new Error('PAC turn was cancelled before it started')
      if (state.busy) throw new Error('A PAC turn is already running in this session')
      state.busy = true
      const cancel = () => { try { Promise.resolve(session.cancel()).catch(() => {}) } catch {} }
      signal?.addEventListener('abort', cancel, { once: true })
      let clearMarker
      try {
        if (state.model !== binding.model) {
          if (typeof session.selectModel !== 'function') throw new Error('PAC model switching is unavailable in this session')
          await session.selectModel(binding.model)
          if (store) await store.write({ version: 1, sessionId: binding.sessionId, pacId: state.pacId, remoteSessionId: session.sourceSessionId, model: binding.model, workspace: binding.cwd })
          state.model = binding.model
        }
        clearMarker = await journal?.begin(binding.sessionId)
        if (signal?.aborted) { await clearMarker?.(); throw new Error('PAC turn was cancelled before it started') }
        const result = await session.prompt(prompt, onUpdate)
        if (result?.stopReason === 'end_turn' || result?.stopReason === 'cancelled') await clearMarker?.()
        return result
      } catch (error) {
        // A failed in-flight call may have performed side effects; do not replay.
        state.lost = true
        throw error
      } finally { signal?.removeEventListener('abort', cancel); state.busy = false }
    },
    async cancel(sessionId) {
      identity(sessionId, 'OpenCode session identity')
      const state = sessions.get(sessionId)
      if (!state || !state.busy || !state.session) return false
      await state.session.cancel()
      return true
    },
    async compact(sessionId) {
      identity(sessionId, 'OpenCode session identity')
      const existing = sessions.get(sessionId)
      const saved = existing ? null : await store?.read(sessionId)
      const legacy = !existing && !saved ? await legacyStore?.read(sessionId) : null
      if (!existing && !saved && !legacy) return null
      const binding = existing ? { sessionId, model: existing.model, cwd: existing.cwd }
        : saved ? { sessionId, model: saved.model, cwd: saved.workspace }
          : { sessionId, model: `PAC_${legacy.pacId}/${legacy.model}`, cwd: legacy.workspace }
      const { state, session } = await getSession(binding, true)
      if (state.busy || typeof session.compact !== 'function') throw new Error('PAC session is unavailable or busy')
      state.busy = true
      let clearMarker
      try {
        clearMarker = await journal?.begin(sessionId)
        const result = await session.compact()
        if (result?.status !== 'completed' || typeof result.summary !== 'string') throw new Error('PAC compaction was not confirmed')
        await clearMarker?.()
        return result
      } catch (error) { state.lost = true; throw error }
      finally { state.busy = false }
    },
    async stopTask(binding, taskId) {
      identity(binding.sessionId, 'OpenCode session identity')
      identity(taskId, 'task identity')
      if (/\s/.test(taskId)) throw new Error('Invalid task identity')
      const state = sessions.get(binding.sessionId)
      if (closed || !state || state.lost || !state.session || !samePac(state.model, binding.model) || state.cwd !== binding.cwd || typeof state.session.stopTask !== 'function') throw new Error('Live PAC session is unavailable')
      return state.session.stopTask(taskId)
    },
    close() {
      if (closed) return
      closed = true
      for (const state of sessions.values()) state.session?.close()
    },
  }
}
