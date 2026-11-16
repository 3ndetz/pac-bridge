import { randomUUID } from 'node:crypto'
import { normalizePacBackgroundTasks } from './pac-background-tasks.mjs'

export function createPacSnapshotGate({ publish }) {
  if (typeof publish !== 'function') throw new Error('Invalid PAC snapshot publisher')
  const sessions = new Map()
  const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\s\x00-\x1f\x7f]/.test(value)
  const stateFor = (sessionId, epoch) => {
    if (!identity(sessionId) || !identity(epoch)) throw new Error('Invalid PAC snapshot identity')
    const state = sessions.get(sessionId)
    if (!state || state.epoch !== epoch) throw new Error('Stale PAC snapshot epoch')
    return state
  }
  function emit(sessionId, state) {
    const ready = state.handshake && state.authoritative
    try { publish({ sessionId, epoch: state.epoch, availability: ready ? 'ready' : 'unknown', ...(ready ? { tasks: state.tasks.map(task => ({ ...task })) } : {}) }) }
    catch (error) { sessions.delete(sessionId); throw error }
  }
  return {
    open(sessionId) {
      if (!identity(sessionId)) throw new Error('Invalid PAC snapshot identity')
      if (!sessions.has(sessionId) && sessions.size >= 4096) throw new Error('PAC snapshot session capacity reached')
      const state = { epoch: randomUUID(), handshake: false, authoritative: false, tasks: [] }
      sessions.set(sessionId, state)
      emit(sessionId, state)
      return state.epoch
    },
    handshake(sessionId, epoch) {
      const state = stateFor(sessionId, epoch)
      state.handshake = true
      emit(sessionId, state)
    },
    authoritative(sessionId, epoch, tasks) {
      const state = stateFor(sessionId, epoch)
      const clean = normalizePacBackgroundTasks(tasks)
      state.tasks = clean
      state.authoritative = true
      emit(sessionId, state)
    },
    update(sessionId, epoch, tasks) {
      const state = stateFor(sessionId, epoch)
      if (!state.authoritative) throw new Error('PAC snapshot is not authoritative')
      state.tasks = normalizePacBackgroundTasks(tasks)
      emit(sessionId, state)
    },
    disconnect(sessionId, epoch) {
      const state = stateFor(sessionId, epoch)
      state.authoritative = false
      state.handshake = false
      state.tasks = []
      sessions.delete(sessionId)
      emit(sessionId, state)
    },
  }
}
