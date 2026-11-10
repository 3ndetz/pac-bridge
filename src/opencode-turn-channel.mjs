import { createPermissionBroker } from './opencode-permissions.mjs'

// A single remote turn can outlive an individual OpenCode provider request:
// permission prompts split it into multiple request/response segments.
export function createOpencodeTurnChannel({ sessionId, maxQueued = 256 } = {}) {
  if (typeof sessionId !== 'string' || !sessionId || !Number.isSafeInteger(maxQueued) || maxQueued < 1) throw new Error('Invalid turn channel')
  const broker = createPermissionBroker({ limit: maxQueued })
  const queue = []
  const waiters = []
  let terminal = null
  let started = false
  let closed = false
  function enqueue(event) {
    if (closed || terminal) throw new Error('Turn channel is closed')
    if (waiters.length) { waiters.shift().resolve(event); return }
    if (queue.length >= maxQueued) { fail(new Error('Turn event queue exceeded')); throw new Error('Turn event queue exceeded') }
    queue.push(event)
  }
  function fail(error) {
    if (terminal || closed) return
    terminal = { type: 'error', error }
    broker.close()
    for (const waiter of waiters.splice(0)) waiter.resolve(terminal)
  }
  return {
    start(run) {
      if (started || closed || typeof run !== 'function') throw new Error('Turn already started or unavailable')
      started = true
      Promise.resolve().then(() => run((event) => enqueue({ type: 'update', event }))).then((result) => {
        if (closed || terminal) return
        terminal = { type: 'done', result }
        for (const waiter of waiters.splice(0)) waiter.resolve(terminal)
      }, fail)
    },
    async requestPermission(params, signal) {
      if (closed || terminal) throw new Error('Turn is unavailable')
      const permission = broker.request({ sessionId, options: params.options, signal })
      if (permission.id) enqueue({ type: 'permission', id: permission.id, toolCall: params.toolCall, options: params.options, question: params?._meta?.pac?.question === true })
      return permission.result
    },
    resolvePermission(id, owner, optionId, answers) { broker.resolve({ id, sessionId: owner, optionId, answers }) },
    next() {
      if (queue.length) return Promise.resolve(queue.shift())
      if (terminal) return Promise.resolve(terminal)
      if (closed) return Promise.resolve({ type: 'error', error: new Error('Turn channel is closed') })
      return new Promise((resolve) => waiters.push({ resolve }))
    },
    close() {
      if (closed) return
      closed = true
      broker.close()
      const error = { type: 'error', error: new Error('Turn channel is closed') }
      for (const waiter of waiters.splice(0)) waiter.resolve(error)
    },
  }
}
