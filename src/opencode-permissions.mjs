import { randomUUID } from 'node:crypto'

// Correlate an ACP permission with exactly one OpenCode session and one reply.
export function createPermissionBroker({ limit = 256 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid permission limit')
  const pending = new Map()
  let closed = false
  const valid = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f]/.test(value)
  function remove(id) {
    const item = pending.get(id)
    if (!item) return null
    pending.delete(id)
    item.signal?.removeEventListener('abort', item.abort)
    return item
  }
  return {
    request({ sessionId, options, signal }) {
      if (closed || !valid(sessionId) || !Array.isArray(options) || !options.length || options.length > 32 ||
          options.some((option) => !valid(option?.optionId) || !['allow_once', 'allow_always', 'reject_once', 'reject_always'].includes(option.kind)) ||
          new Set(options.map((option) => option.optionId)).size !== options.length) throw new Error('Invalid permission request')
      if (pending.size >= limit) throw new Error('Too many pending permissions')
      if (signal?.aborted) return { id: null, result: Promise.resolve({ outcome: { outcome: 'cancelled' } }) }
      const id = randomUUID()
      let resolve
      const result = new Promise((done) => { resolve = done })
      const item = { sessionId, options: structuredClone(options), signal, resolve, abort: () => {
        const entry = remove(id)
        entry?.resolve({ outcome: { outcome: 'cancelled' } })
      } }
      pending.set(id, item)
      signal?.addEventListener('abort', item.abort, { once: true })
      return { id, result }
    },
    resolve({ id, sessionId, optionId }) {
      if (!valid(id) || !valid(sessionId) || !valid(optionId)) throw new Error('Invalid permission reply')
      const item = pending.get(id)
      if (!item || item.sessionId !== sessionId || !item.options.some((option) => option.optionId === optionId)) throw new Error('Unknown or invalid permission reply')
      remove(id).resolve({ outcome: { outcome: 'selected', optionId } })
    },
    close() {
      if (closed) return
      closed = true
      for (const id of [...pending.keys()]) remove(id).resolve({ outcome: { outcome: 'cancelled' } })
    },
  }
}
