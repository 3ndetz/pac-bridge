import { createSourceSnapshotComposite } from './sdk-source-snapshot.mjs'

export function createCoordinatedSourceBarrier({sourceSessionId,query,terminals,acquireQuiescence,captureSdk,publish,onDeliveryFailure,timeoutMs=5000}) {
  if (!query || !terminals || typeof terminals.snapshotState !== 'function' || typeof acquireQuiescence !== 'function' || typeof captureSdk !== 'function' || typeof publish !== 'function' || typeof onDeliveryFailure !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid coordinated source barrier')
  let active = true, pending = null
  const composite = createSourceSnapshotComposite({sourceSessionId,query,terminals,publish:value=>{
    try { publish(value) } catch (error) {
      if (active) {
        active=false
        if (pending) {pending.invalid=true;pending.controller.abort()}
        try { onDeliveryFailure() } catch {}
      }
      throw error
    }
  }})
  function invalidate() {
    if (!active) return
    if (pending) { pending.invalid = true; pending.controller.abort() }
    composite.invalidate()
  }
  async function snapshot() {
    if (!active || pending) throw new Error('Source barrier unavailable')
    composite.invalidate()
    const lease = acquireQuiescence()
    if (!lease || typeof lease.valid !== 'function' || typeof lease.release !== 'function') throw new Error('Source is not quiescent')
    let valid = false
    try { valid = lease.valid() === true } catch {}
    if (!valid) { lease.release(); throw new Error('Source is not quiescent') }
    const attempt = {invalid:false,controller:new AbortController()}
    pending = attempt
    let timer, expired = false
    const operation = (async()=>{
      const state = terminals.snapshotState()
      if (!state?.complete || state.starting !== 0 || state.uncertain !== 0 || !Number.isSafeInteger(state.revision)) throw new Error('Terminal state incomplete')
      const sdk = await captureSdk({query,sourceSessionId,lease,signal:attempt.controller.signal})
      const valid = () => active && !attempt.invalid && lease.valid() && terminals.snapshotState().revision === state.revision
      if (!valid() || sdk?.query !== query || sdk?.sourceSessionId !== sourceSessionId || sdk?.complete !== true) throw new Error('SDK snapshot is not authoritative for this source')
      const proof = {barrier:lease,generation:composite.generation,complete:true,healthy:true,starting:0,uncertain:0,valid}
      composite.sdk(query,sourceSessionId,sdk.tasks,proof)
      composite.terminal(terminals,sourceSessionId,state.tasks,proof)
    })()
    const deadline = new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(new Error('Source barrier timed out'))},timeoutMs)})
    try { await Promise.race([operation,deadline]) }
    catch (error) { invalidate(); throw error }
    finally {
      clearTimeout(timer)
      if (expired) {
        operation.catch(()=>{}).finally(()=>{if(pending===attempt)pending=null;lease.release()})
      } else { if(pending===attempt)pending=null;lease.release() }
    }
  }
  function close() {
    if (!active) return
    if (pending) {pending.invalid=true;pending.controller.abort()}
    active=false
    composite.close()
  }
  return {snapshot,invalidate,close,get epoch(){return composite.epoch}}
}
