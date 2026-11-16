export function createPacSourceBinding({agent,rootSessionId,sdkSessionId,query,onInvalidated}) {
  const validId=value=>typeof value==='string' && value.length>0 && value.length<=512 && !/[\s\x00-\x1f\x7f]/.test(value)
  if (!agent || !validId(rootSessionId) || !validId(sdkSessionId) || !query || typeof onInvalidated !== 'function') throw new Error('Invalid source binding')
  const session=agent.sessions?.[rootSessionId]
  if (!session || session.query!==query || session.queryClosed) throw new Error('Source query ownership unavailable')
  let active=true,witnessed=false
  function invalidate() {
    if (!active) return
    active=false;witnessed=false
    onInvalidated()
  }
  function owned() {
    if (!active) return false
    if (agent.sessions?.[rootSessionId]!==session || session.query!==query || session.queryClosed) { invalidate(); return false }
    return true
  }
  function observe(actual,message) {
    if (!owned() || actual!==query) {invalidate();throw new Error('Source query changed')}
    if (message?.type !== 'system' || message?.subtype !== 'background_tasks_changed') return
    if (message.session_id !== sdkSessionId) {invalidate();throw new Error('Foreign SDK session')}
    witnessed=true
  }
  return {owned,observe,trusted:()=>owned() && witnessed,invalidate,close:invalidate}
}
