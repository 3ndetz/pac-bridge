export function createSourceQuiescence({onInvalidate}) {
  if (typeof onInvalidate !== 'function') throw new Error('Invalid source quiescence callback')
  const active = new Set(), domains = new Set(['turn','hook','permission','terminal','mcp','sdk_callback','control'])
  let closed=false, lease=null, revision=0
  function invalidate() {
    if (closed) return
    revision++
    if (lease) lease.invalid=true
    try { onInvalidate() } catch (error) { closed=true; throw error }
  }
  function begin(domain,preempt) {
    if (closed || !domains.has(domain) || (lease && !preempt)) throw new Error('Source operation unavailable')
    const token={domain}
    active.add(token)
    try { invalidate() } catch (error) { active.delete(token); throw error }
    let ended=false
    return () => {
      if (ended) return
      ended=true
      active.delete(token)
      invalidate()
    }
  }
  function enter(domain) { return begin(domain,false) }
  function enterExternal(domain) { return begin(domain,true) }
  function wrapExternal(domain,callback) {
    if (typeof callback !== 'function') throw new Error('Invalid source callback')
    return async function(...args) {
      const finish=enterExternal(domain)
      try { return await callback.apply(this,args) } finally { finish() }
    }
  }
  function acquire() {
    if (closed || lease || active.size) return null
    const token={invalid:false,revision}
    lease=token
    return {
      valid:()=>!closed && lease===token && !token.invalid && revision===token.revision && active.size===0,
      release:()=>{if(lease===token)lease=null},
    }
  }
  function close() {
    if (closed) return
    try { invalidate() } finally { closed=true }
  }
  return {enter,enterExternal,wrapExternal,acquire,invalidate,close,get activeCount(){return active.size}}
}
