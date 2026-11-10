export function createSubagentTranslator({ localSessionId, remoteSessionId, pacId }) {
  if (![localSessionId, remoteSessionId, pacId].every((value) => typeof value === 'string' && value)) throw new Error('Invalid subagent routing identity')
  const children = new Map()
  const scoped = (id) => `${pacId}:${id}`

  return {
    remoteChildId(childId) {
      for (const [remoteId, child] of children) if (child.id === childId && child.active) return remoteId
      throw new Error('Unknown or inactive child session')
    },
    toolCallId(ownerSessionId, toolCallId) {
      if (typeof toolCallId !== 'string' || !toolCallId) throw new Error('Invalid tool identity')
      if (ownerSessionId === remoteSessionId) return toolCallId
      const child = children.get(ownerSessionId)
      if (!child || !child.active) throw new Error('Unknown or inactive tool owner')
      return `${child.id}:${toolCallId}`
    },
    translate(params) {
      const update = params?.update
      if (!update || typeof params.sessionId !== 'string') throw new Error('Invalid subagent event')
      if (update.sessionUpdate === 'subagent_spawned') {
        const id = update.subagentSessionId
        if (typeof id !== 'string' || !id || children.has(id)) throw new Error('Invalid or duplicate subagent identity')
        const parent = params.sessionId === remoteSessionId ? null : children.get(params.sessionId)
        if (params.sessionId !== remoteSessionId && !parent) throw new Error('Unknown subagent parent')
        const child = { id: scoped(id), parent: parent?.id || localSessionId, depth: (parent?.depth || 0) + 1,
          name: typeof update.name === 'string' ? update.name : 'Subagent', background: update._meta?.pacBridge?.background === true, active: true }
        children.set(id, child)
        return { method: 'opencode/session/child_update', params: { rootSessionId: localSessionId, childSessionId: child.id,
          parentSessionId: child.parent, depth: child.depth, type: 'status', status: 'created' } }
      }
      if (update.sessionUpdate === 'subagent_state_update') {
        const child = children.get(update.subagentSessionId)
        if (!child) throw new Error('Unknown subagent identity')
        const status = ({ completed: 'completed', failed: 'failed', cancelled: 'interrupted', disconnected: 'failed' })[update.state]
        if (!status) throw new Error('Unsupported subagent state')
        child.active = false
        return { method: 'opencode/session/child_update', params: { rootSessionId: localSessionId, childSessionId: child.id,
          parentSessionId: child.parent, depth: child.depth, type: 'status', status } }
      }
      if (params.sessionId === remoteSessionId) return { method: 'session/update', params: { ...params, sessionId: localSessionId } }
      const child = children.get(params.sessionId)
      if (!child) throw new Error('Unknown child session')
      const translated = structuredClone(update)
      if (typeof translated.toolCallId === 'string') translated.toolCallId = `${child.id}:${translated.toolCallId}`
      translated._meta = { ...translated._meta, 'opencode/child-session': { id: child.id, parentID: child.parent, depth: child.depth } }
      return { method: 'opencode/session/child_update', params: { rootSessionId: localSessionId, childSessionId: child.id,
        parentSessionId: child.parent, depth: child.depth, type: 'update', update: translated } }
    },
    backgroundTasks() {
      return [...children.values()].filter((child) => child.active && child.background).map((child) => ({
        task_id: child.id, task_type: 'agent', description: child.name,
      }))
    },
  }
}
