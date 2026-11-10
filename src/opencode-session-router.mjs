// Maps OpenCode session identities to dedicated ACP sessions. The caller owns
// the transport and translates the updates and permission requests it receives.
export function createOpencodeSessionRouter({ openSession }) {
  if (typeof openSession !== 'function') throw new Error('openSession is required')
  const sessions = new Map()
  let closed = false

  function identity(value, label) {
    if (typeof value !== 'string' || !value || value.length > 512 || /[\x00-\x1f]/.test(value)) throw new Error(`Invalid ${label}`)
    return value
  }

  async function getSession({ sessionId, model, cwd }) {
    identity(sessionId, 'OpenCode session identity')
    identity(model, 'PAC model')
    identity(cwd, 'workspace')
    if (closed) throw new Error('Session router is closed')
    let state = sessions.get(sessionId)
    if (state) {
      if (state.model !== model || state.cwd !== cwd) throw new Error('PAC model or workspace changed; start a new session')
    } else {
      state = { model, cwd, busy: false, lost: false, opening: null, session: null }
      sessions.set(sessionId, state)
      state.opening = Promise.resolve().then(() => openSession({ sessionId, model, cwd })).then((session) => {
        if (!session || typeof session.prompt !== 'function' || typeof session.cancel !== 'function' || typeof session.close !== 'function') throw new Error('Invalid ACP session')
        state.session = session
        if (closed) { session.close(); throw new Error('Session router is closed') }
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
    async prompt(binding, prompt, onUpdate) {
      if (!Array.isArray(prompt) || typeof onUpdate !== 'function') throw new Error('Invalid PAC prompt')
      const { state, session } = await getSession(binding)
      if (state.busy) throw new Error('A PAC turn is already running in this session')
      state.busy = true
      try {
        return await session.prompt(prompt, onUpdate)
      } catch (error) {
        // A failed in-flight call may have performed side effects; do not replay.
        state.lost = true
        throw error
      } finally { state.busy = false }
    },
    async cancel(sessionId) {
      identity(sessionId, 'OpenCode session identity')
      const state = sessions.get(sessionId)
      if (!state || !state.busy || !state.session) return false
      await state.session.cancel()
      return true
    },
    close() {
      if (closed) return
      closed = true
      for (const state of sessions.values()) state.session?.close()
    },
  }
}
