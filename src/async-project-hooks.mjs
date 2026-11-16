export function createAsyncProjectHooks({ maxRunning = 32, maxQueuedBytes = 1024 * 1024 } = {}) {
  const active = new Set(), queued = []
  let closed = false, queuedBytes = 0, overflow = false
  return {
    ensureCapacity(count) { if (closed || !Number.isSafeInteger(count) || count < 0 || active.size + count > maxRunning) throw new Error('Async source hook capacity is unavailable') },
    submit(start) {
      if (closed || active.size >= maxRunning) throw new Error('Async source hook capacity is unavailable')
      const task = { stop: null }
      active.add(task)
      let work
      try { work = start(stop => { task.stop = stop; if (closed) stop() }) }
      catch (error) { active.delete(task); throw error }
      Promise.resolve(work).then(output => {
        if (closed || !output || typeof output !== 'object') return
        const parts = [output.hookSpecificOutput?.additionalContext, output.systemMessage].filter(value => typeof value === 'string' && value)
        const text = parts.join('\n\n')
        const bytes = Buffer.byteLength(text, 'utf8')
        if (text && queuedBytes + bytes <= maxQueuedBytes) { queued.push(text); queuedBytes += bytes }
        else if (text) overflow = true
      }, () => {}).finally(() => active.delete(task))
    },
    hasReady() { return queued.length > 0 || overflow },
    hasPending() { return active.size > 0 || queued.length > 0 || overflow },
    drain() { if (overflow) throw new Error('Async source hook output capacity exceeded'); const result = queued.splice(0); queuedBytes = 0; return result },
    close() { closed = true; queued.length = 0; queuedBytes = 0; for (const task of active) { try { task.stop?.() } catch {} } },
  }
}
