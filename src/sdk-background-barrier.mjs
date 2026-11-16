import { randomUUID } from 'node:crypto'

export function createSdkSnapshotBarrier({ query, sdkSessionId, acquireQuiescence, publish, timeoutMs = 5000 }) {
  const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\s\x00-\x1f\x7f]/.test(value)
  if (!query || typeof query.reinitialize !== 'function' || !validId(sdkSessionId) || typeof acquireQuiescence !== 'function' || typeof publish !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid SDK snapshot barrier')
  const epoch = randomUUID()
  let alive = true, pending = null, revision = 0
  function unknown() { publish({ epoch, availability:'unknown' }) }
  function normalize(tasks) {
    if (!Array.isArray(tasks) || tasks.length > 128) throw new Error('Invalid SDK task snapshot')
    const ids = new Set()
    const clean = tasks.map(task => {
      if (!task || typeof task !== 'object' || Array.isArray(task) || !validId(task.task_id) || ids.has(task.task_id) ||
          (task.run_id !== undefined && !validId(task.run_id)) || typeof task.task_type !== 'string' || !task.task_type.trim() || task.task_type.length > 128 || /[\x00-\x1f\x7f]/.test(task.task_type) ||
          typeof task.description !== 'string' || task.description.length > 4096) throw new Error('Invalid SDK background task')
      ids.add(task.task_id)
      return { task_id:task.task_id, ...(task.run_id === undefined ? {} : {run_id:task.run_id}), task_type:task.task_type, description:task.description }
    })
    if (Buffer.byteLength(JSON.stringify(clean)) > 1024 * 1024) throw new Error('SDK task snapshot exceeds size limit')
    return clean
  }
  function observe(actualQuery, message) {
    if (!alive || actualQuery !== query) throw new Error('Unowned SDK query')
    if (message?.type !== 'system' || message?.subtype !== 'background_tasks_changed') return
    if (message.session_id !== sdkSessionId) { revision++; unknown(); throw new Error('Foreign SDK snapshot') }
    let tasks
    try { tasks = normalize(message.tasks) } catch (error) { revision++; unknown(); throw error }
    revision++
    if (!pending?.awaiting || !pending.lease.valid()) { unknown(); return }
    pending.accept({value:{epoch,availability:'ready',tasks},revision})
  }
  async function snapshot() {
    if (!alive || pending) throw new Error('SDK snapshot barrier unavailable')
    const lease = acquireQuiescence()
    if (!lease || typeof lease.valid !== 'function' || typeof lease.release !== 'function' || !lease.valid()) throw new Error('SDK session is not quiescent')
    let resolveEvent
    const event = new Promise(resolve => { resolveEvent = resolve })
    let resolveSettled
    const settled = new Promise(resolve => { resolveSettled = resolve })
    const attempt = { lease, awaiting:false, accept:resolveEvent, abandoned:false, settled }
    pending = attempt
    let timer
    const timed = new Promise((_,reject) => { timer=setTimeout(() => reject(new Error('SDK snapshot barrier timed out')),timeoutMs) })
    const operation = (async () => {
      await query.reinitialize()
      if (!alive || attempt.abandoned || !lease.valid()) throw new Error('SDK snapshot barrier invalidated')
      attempt.awaiting = true
      const accepted = await event
      if (!alive || attempt.abandoned || !lease.valid() || !accepted || accepted.revision !== revision) throw new Error('SDK snapshot barrier invalidated')
      return accepted.value
    })()
    try {
      const value = await Promise.race([operation,timed])
      publish(value)
      return value
    } catch (error) {
      attempt.abandoned = true
      unknown()
      throw error
    } finally {
      clearTimeout(timer)
      const release = () => {
        if (pending === attempt) pending = null
        try { lease.release() } finally { resolveSettled() }
      }
      if (attempt.abandoned && !attempt.awaiting) {
        operation.catch(() => {}).finally(release).catch(() => {})
      } else {
        release()
      }
    }
  }
  function close() {
    if (!alive) return
    alive = false; revision++
    if (pending) pending.accept(null)
    unknown()
  }
  return { epoch, observe, snapshot, close, whenSettled() { return pending?.settled || Promise.resolve() }, get revision() { return revision } }
}

export function installSdkSnapshotTap(query, observe) {
  if (!query || typeof query.next !== 'function' || typeof observe !== 'function') throw new Error('Invalid SDK query tap')
  const original = query.next
  let active = true
  function tapped(...args) {
    return Promise.resolve(original.apply(query,args)).then(result => {
      if (active && result && !result.done && result.value) observe(query,result.value)
      return result
    })
  }
  query.next = tapped
  if (query.next !== tapped) throw new Error('SDK query tap could not be installed')
  return () => { active = false; if (query.next === tapped) query.next = original }
}
