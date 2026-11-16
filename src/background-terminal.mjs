import { randomUUID } from 'node:crypto'

export function createBackgroundTerminal({ terminal, sessionId, onChange = () => {}, onUncertain = () => {}, onDeliveryFailure = () => {}, maxTasks = 16, maxRetainedTasks = 128 }) {
  if (!terminal || typeof sessionId !== 'string' || !sessionId || typeof onChange !== 'function' || typeof onUncertain !== 'function' || typeof onDeliveryFailure !== 'function' ||
      !Number.isSafeInteger(maxTasks) || maxTasks < 1 || !Number.isSafeInteger(maxRetainedTasks) || maxRetainedTasks < maxTasks) throw new Error('Invalid background task configuration')
  const tasks = new Map()
  let starting = 0, uncertainStarts = 0, deliveryUncertain = false, revision = 0

  function check(params) {
    if (params?.sessionId !== sessionId) throw new Error('Unknown workspace session')
    const task = tasks.get(params.taskId)
    if (!task) throw new Error('Unknown background shell task')
    return task
  }

  function snapshot() {
    return [...tasks.values()].filter((task) => task.status === 'running' || task.status === 'unknown').map((task) => ({
      task_id: task.id, task_type: 'local_bash', description: task.description,
    }))
  }

  function snapshotState() {
    const uncertain = uncertainStarts + [...tasks.values()].filter((task) => task.releaseUncertain || task.status === 'unknown').length + (deliveryUncertain ? 1 : 0)
    return { tasks: snapshot(), starting, uncertain, complete: starting === 0 && uncertain === 0, revision }
  }

  function changed() {
    revision++
    const state = snapshotState()
    function lostDelivery() {
      if (deliveryUncertain) return
      deliveryUncertain = true
      try { onDeliveryFailure() } catch {}
    }
    if (!state.complete) {
      try { onUncertain(state) } catch { lostDelivery() }
      return
    }
    try { onChange(state.tasks, state) } catch {
      lostDelivery()
      try { onUncertain(snapshotState()) } catch { lostDelivery() }
    }
  }

  return {
    snapshot, snapshotState,
    async start(params, { signal } = {}) {
      if (params?.sessionId !== sessionId) throw new Error('Unknown workspace session')
      if ([...tasks.values()].filter((task) => task.status === 'running' || task.status === 'unknown' || task.releaseUncertain).length + starting + uncertainStarts >= maxTasks) throw new Error('Background task limit reached')
      if (tasks.size + starting + uncertainStarts >= maxRetainedTasks) throw new Error('Background task history limit reached')
      if (params.description !== undefined && (typeof params.description !== 'string' || params.description.length > 512)) throw new Error('Invalid task description')
      if (params.timeoutMs !== undefined && (!Number.isSafeInteger(params.timeoutMs) || params.timeoutMs < 1 || params.timeoutMs > 120000)) throw new Error('Invalid background task timeout')
      starting++; changed()
      let terminalId, created = false, recorded = false, released = false
      try {
        ;({ terminalId } = await terminal.create(params, { signal }))
        if (typeof terminalId !== 'string' || !terminalId) throw new Error('Terminal creation outcome is unknown')
        created = true
        if (signal?.aborted) {
          await terminal.release({ sessionId, terminalId })
          released = true
          throw new Error('Background command cancelled; outcome may be unknown')
        }
        const task = { id: `pac-shell-${randomUUID()}`, terminalId, description: params.description || 'Background shell command', status: 'running' }
        tasks.set(task.id, task); recorded = true
        const timer = params.timeoutMs ? setTimeout(() => {
          task.timedOut = true
          void terminal.kill({ sessionId, terminalId }).catch(() => {})
        }, params.timeoutMs) : null
        task.done = (async () => {
          try {
            const exit = await terminal.waitForExit({ sessionId, terminalId })
            task.result = { exitStatus: exit }
            task.status = task.timedOut ? 'timed_out' : task.stopping ? 'stopped' : exit.exitCode === 0 ? 'completed' : 'failed'
            try { task.result = { ...terminal.output({ sessionId, terminalId }), exitStatus: exit } }
            catch { task.error = 'Background task output is unavailable' }
          } catch {
            task.status = 'unknown'
            task.error = 'Background task outcome is unknown'
          } finally {
            clearTimeout(timer)
            task.releaseUncertain = true; changed()
            try { await terminal.release({ sessionId, terminalId }); task.releaseUncertain = false } catch {}
            changed()
          }
        })()
        changed()
        return { taskId: task.id }
      } catch (error) {
        if (!recorded && (!created || !released)) uncertainStarts++
        throw error
      } finally { starting--; changed() }
    },
    async output(params) {
      const task = check(params)
      const timeoutMs = params.timeoutMs ?? 30000
      if (typeof params.block !== 'boolean' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('Invalid task output options')
      if (params.block && task.status === 'running') {
        let timer
        await Promise.race([task.done, new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs) })]).finally(() => clearTimeout(timer))
      }
      if (task.status === 'running') {
        try { return { status: 'running', ...terminal.output({ sessionId, terminalId: task.terminalId }) } } catch { await task.done }
      }
      return { status: task.status, ...(task.result || {}), ...(task.error ? { error: task.error } : {}) }
    },
    async stop(params) {
      const task = check(params)
      if (task.status === 'running') {
        task.stopping = true
        try { await terminal.kill({ sessionId, terminalId: task.terminalId }) } catch (error) { task.stopping = false; task.releaseUncertain = true; changed(); throw error }
        await task.done
      }
      if (task.status === 'unknown') throw new Error('Background task outcome is unknown')
      return { status: task.status }
    },
  }
}
