import { randomUUID } from 'node:crypto'

export function createBackgroundTerminal({ terminal, sessionId, onChange = () => {}, maxTasks = 16, maxRetainedTasks = 128 }) {
  if (!terminal || typeof sessionId !== 'string' || !sessionId || typeof onChange !== 'function' ||
      !Number.isSafeInteger(maxTasks) || maxTasks < 1 || !Number.isSafeInteger(maxRetainedTasks) || maxRetainedTasks < maxTasks) throw new Error('Invalid background task configuration')
  const tasks = new Map()
  let starting = 0

  function check(params) {
    if (params?.sessionId !== sessionId) throw new Error('Unknown workspace session')
    const task = tasks.get(params.taskId)
    if (!task) throw new Error('Unknown background shell task')
    return task
  }

  function snapshot() {
    return [...tasks.values()].filter((task) => task.status === 'running').map((task) => ({
      task_id: task.id, task_type: 'local_bash', description: task.description,
    }))
  }

  function changed() { try { onChange(snapshot()) } catch {} }

  return {
    snapshot,
    async start(params, { signal } = {}) {
      if (params?.sessionId !== sessionId) throw new Error('Unknown workspace session')
      if ([...tasks.values()].filter((task) => task.status === 'running').length + starting >= maxTasks) throw new Error('Background task limit reached')
      if (tasks.size + starting >= maxRetainedTasks) throw new Error('Background task history limit reached')
      if (params.description !== undefined && (typeof params.description !== 'string' || params.description.length > 512)) throw new Error('Invalid task description')
      if (params.timeoutMs !== undefined && (!Number.isSafeInteger(params.timeoutMs) || params.timeoutMs < 1 || params.timeoutMs > 120000)) throw new Error('Invalid background task timeout')
      starting++
      let terminalId
      try {
        ;({ terminalId } = await terminal.create(params, { signal }))
        if (signal?.aborted) {
          await terminal.release({ sessionId, terminalId })
          throw new Error('Background command cancelled; outcome may be unknown')
        }
        const task = { id: `pac-shell-${randomUUID()}`, terminalId, description: params.description || 'Background shell command', status: 'running' }
        tasks.set(task.id, task)
        const timer = params.timeoutMs ? setTimeout(() => {
          task.timedOut = true
          void terminal.kill({ sessionId, terminalId }).catch(() => {})
        }, params.timeoutMs) : null
        task.done = (async () => {
          try {
            const exit = await terminal.waitForExit({ sessionId, terminalId })
            const output = terminal.output({ sessionId, terminalId })
            task.result = { ...output, exitStatus: exit }
            task.status = task.timedOut ? 'timed_out' : task.stopping ? 'stopped' : exit.exitCode === 0 ? 'completed' : 'failed'
          } catch (error) {
            task.status = 'failed'
            task.error = error.message
          } finally {
            clearTimeout(timer)
            try { await terminal.release({ sessionId, terminalId }) } catch {}
            changed()
          }
        })()
        changed()
        return { taskId: task.id }
      } finally { starting-- }
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
        try { await terminal.kill({ sessionId, terminalId: task.terminalId }) } catch (error) { task.stopping = false; throw error }
        await task.done
      }
      return { status: task.status }
    },
  }
}
