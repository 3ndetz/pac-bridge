export function createAsyncProjectHooks({ maxRunning = 32, maxQueuedBytes = 1024 * 1024 } = {}) {
  const active = new Set(), queued = []
  let closed = false, queuedBytes = 0, overflow = false
  return {
    ensureCapacity(count) { if (closed || !Number.isSafeInteger(count) || count < 0 || active.size + count > maxRunning) throw new Error('Async source hook capacity is unavailable') },
    submit(start) {
      if (closed || active.size >= maxRunning) throw new Error('Async source hook capacity is unavailable')
      const task = { stop: null, failure: null }
      task.completion = new Promise(resolve => { task.complete = resolve })
      active.add(task)
      let work
      try { work = start(stop => { task.stop = stop; if (closed) stop() }) }
      catch (error) { active.delete(task); task.complete(); throw error }
      Promise.resolve(work).then(output => {
        if (closed || !output || typeof output !== 'object') return
        const parts = [output.hookSpecificOutput?.additionalContext, output.systemMessage].filter(value => typeof value === 'string' && value)
        const text = parts.join('\n\n')
        const bytes = Buffer.byteLength(text, 'utf8')
        if (text && queuedBytes + bytes <= maxQueuedBytes) { queued.push(text); queuedBytes += bytes }
        else if (text) overflow = true
      }, error => { if (error?.code === 'PAC_PROCESS_EXIT_UNCONFIRMED') task.failure = error }).finally(() => {
        if (!task.failure) active.delete(task)
        task.complete()
      })
    },
    hasReady() { return queued.length > 0 || overflow || [...active].some(task => task.failure) },
    hasPending() { return active.size > 0 || queued.length > 0 || overflow },
    drain() { if ([...active].some(task => task.failure)) throw new Error('Async source hook cleanup is unconfirmed'); if (overflow) throw new Error('Async source hook output capacity exceeded'); const result = queued.splice(0); queuedBytes = 0; return result },
    close() {
      closed = true; queued.length = 0; queuedBytes = 0
      const owners = [...active]
      for (const task of owners) { try { task.stop?.() } catch {} }
      const completed = Promise.all(owners.map(task => task.completion)).then(() => {
        if (owners.some(task => task.failure)) throw new Error('Async source hook cleanup is unconfirmed')
      })
      completed.catch(() => {})
      return completed
    },
  }
}
