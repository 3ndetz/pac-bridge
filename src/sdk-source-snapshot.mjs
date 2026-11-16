import { randomUUID } from 'node:crypto'
import { normalizePacBackgroundTasks } from './pac-background-tasks.mjs'

export function createSourceSnapshotComposite({ sourceSessionId, query, terminals, publish }) {
  const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\s\x00-\x1f\x7f]/.test(value)
  if (!validId(sourceSessionId) || !query || !terminals || typeof publish !== 'function') throw new Error('Invalid source snapshot binding')
  const epoch = randomUUID(), parts = { sdk:null, terminal:null }
  let generation=0, active=true
  function emitUnknown() { publish({epoch,availability:'unknown'}) }
  function invalidate() {
    if (!active) return
    parts.sdk=null; parts.terminal=null; generation++
    emitUnknown()
  }
  function normalize(tasks) {
    const clean=normalizePacBackgroundTasks(tasks)
    return clean.map((task,index)=> {
      const runId=tasks[index].run_id
      if (runId !== undefined && !validId(runId)) throw new Error('Invalid task run identity')
      return {...task,...(runId === undefined ? {} : {run_id:runId})}
    })
  }
  function valid(proof) { try { return proof.valid() === true } catch { return false } }
  function accept(kind, actual, sessionId, value, proof) {
    if (!active) throw new Error('Source snapshot is closed')
    if (sessionId!==sourceSessionId || actual !== (kind==='sdk' ? query : terminals) || !proof || !proof.barrier || typeof proof.barrier !== 'object' || proof.generation !== generation || proof.complete !== true || proof.healthy !== true || proof.starting !== 0 || proof.uncertain !== 0 || typeof proof.valid !== 'function' || !valid(proof)) {
      invalidate(); throw new Error('Untrusted or incomplete source snapshot')
    }
    try {
      const clean=normalize(value)
      if (!valid(proof)) throw new Error('Source snapshot proof expired')
      parts[kind]={tasks:clean,proof}
      if (!parts.sdk || !parts.terminal) { emitUnknown(); return }
      if (parts.sdk.proof.barrier !== parts.terminal.proof.barrier || !valid(parts.sdk.proof) || !valid(parts.terminal.proof)) throw new Error('Source snapshot barrier expired or mismatched')
      const all=[...parts.sdk.tasks,...parts.terminal.tasks], ids=new Set()
      if (all.length>128) throw new Error('Combined task limit exceeded')
      for (const task of all) { if (ids.has(task.task_id)) throw new Error('Duplicate task across source snapshots'); ids.add(task.task_id) }
      if (Buffer.byteLength(JSON.stringify(all))>1024*1024 || !valid(parts.sdk.proof) || !valid(parts.terminal.proof)) throw new Error('Combined snapshot proof expired or too large')
      publish({epoch,availability:'ready',tasks:all})
    } catch(error) { invalidate(); throw error }
  }
  return {
    get epoch(){return epoch}, get generation(){return generation},
    sdk(actual,sessionId,tasks,proof){accept('sdk',actual,sessionId,tasks,proof)},
    terminal(actual,sessionId,tasks,proof){accept('terminal',actual,sessionId,tasks,proof)},
    invalidate,
    close(){if(active){try{invalidate()}finally{active=false}}},
  }
}
