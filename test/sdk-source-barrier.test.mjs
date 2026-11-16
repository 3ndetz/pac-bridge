import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createCoordinatedSourceBarrier } from '../src/sdk-source-barrier.mjs'
import { createSdkSnapshotBarrier } from '../src/sdk-background-barrier.mjs'

function setup(captureSdk, timeoutMs=1000) {
  const query={}, events=[]
  let held=false, valid=true, releases=0, state={tasks:[],starting:0,uncertain:0,complete:true,revision:0}
  const terminals={snapshotState:()=>state}
  const barrier=createCoordinatedSourceBarrier({sourceSessionId:'source',query,terminals,captureSdk,timeoutMs,publish:value=>events.push(value),onDeliveryFailure:()=>{},acquireQuiescence:()=>{
    if(held)return null
    held=true
    return {valid:()=>valid,release:()=>{held=false;releases++}}
  }})
  return {query,terminals,barrier,events,get held(){return held},get releases(){return releases},change(next){state={...state,...next,revision:state.revision+1}},expire(){valid=false}}
}
const complete=({query,sourceSessionId})=>({query,sourceSessionId,complete:true,tasks:[]})

test('one lease covers both snapshots and validates owner, completeness, and revision',async()=>{
 let state
 state=setup(async request=>{assert.equal(state.held,true);return complete(request)})
 await state.barrier.snapshot()
 assert.equal(state.events.at(-1).availability,'ready');assert.equal(state.events.at(-1).epoch,state.barrier.epoch)
 assert.equal(state.held,false);assert.equal(state.releases,1)
 state.barrier.invalidate();assert.equal(state.events.at(-1).availability,'unknown')
 state.barrier.close();const count=state.events.length;state.barrier.invalidate();assert.equal(state.events.length,count)
})

test('notification failure closes the synthetic channel and prevents later ready',async()=>{
 const query={},terminals={snapshotState:()=>({tasks:[],starting:0,uncertain:0,complete:true,revision:0})}
 let failures=0,releases=0
 const barrier=createCoordinatedSourceBarrier({sourceSessionId:'source',query,terminals,captureSdk:async request=>complete(request),publish:value=>{if(value.availability==='ready')throw new Error('transport lost')},onDeliveryFailure:()=>{failures++},acquireQuiescence:()=>({valid:()=>true,release:()=>{releases++}})})
 await assert.rejects(barrier.snapshot(),/transport lost/)
 assert.equal(failures,1);assert.equal(releases,1)
 await assert.rejects(barrier.snapshot(),/unavailable/)
 barrier.close();assert.equal(failures,1)
})

test('foreign identity, incomplete terminals, and changed revision fail closed',async()=>{
 for(const mode of ['foreign-query','foreign-session','incomplete-sdk','terminal-start','terminal-change']) {
  let state
  state=setup(async request=>{
    if(mode==='terminal-change')state.change({})
    return {...complete(request),...(mode==='foreign-query'?{query:{}}:{}),...(mode==='foreign-session'?{sourceSessionId:'other'}:{}),...(mode==='incomplete-sdk'?{complete:false}:{})}
  })
  if(mode==='terminal-start')state.change({starting:1,complete:false})
  await assert.rejects(state.barrier.snapshot(),/incomplete|authoritative/)
  assert.equal(state.events.at(-1).availability,'unknown')
  assert.equal(state.events.some(value=>value.availability==='ready'),false)
  assert.equal(state.releases,1)
 }
})

test('disconnect or reconnect during capture rejects late results and preserves lease until settled',async()=>{
 let finish
 const state=setup(request=>new Promise(resolve=>{finish=()=>resolve(complete(request))}))
 const attempt=state.barrier.snapshot()
 state.barrier.invalidate()
 assert.equal(state.events.at(-1).availability,'unknown')
 finish();await assert.rejects(attempt,/authoritative/)
 assert.equal(state.events.some(value=>value.availability==='ready'),false)
 const old=state.barrier.epoch;state.barrier.close()
 const replacement=setup(async request=>complete(request))
 assert.notEqual(replacement.barrier.epoch,old)
})

test('timed out capture keeps the quiescence lease and rejects retries until completion',async()=>{
 let finish
 const state=setup(request=>new Promise(resolve=>{finish=()=>resolve(complete(request))}),30)
 await assert.rejects(state.barrier.snapshot(),/timed out/)
 assert.equal(state.held,true)
 await assert.rejects(state.barrier.snapshot(),/unavailable/)
 finish();await delay(10)
 assert.equal(state.held,false);assert.equal(state.releases,1)
 assert.equal(state.events.some(value=>value.availability==='ready'),false)
})

test('combines the SDK post-response barrier and terminals under one borrowed lease',async()=>{
 let state
 state=setup(async ({query,sourceSessionId,lease})=>{
  const sdk=createSdkSnapshotBarrier({query,sdkSessionId:sourceSessionId,timeoutMs:500,publish:()=>{},acquireQuiescence:()=>({valid:()=>lease.valid(),release:()=>{}})})
  const pending=sdk.snapshot()
  setImmediate(()=>sdk.observe(query,{type:'system',subtype:'background_tasks_changed',session_id:sourceSessionId,tasks:[{task_id:'agent',task_type:'local_agent',description:'working'}]}))
  const snapshot=await pending
  assert.equal(state.held,true)
  return {query,sourceSessionId,complete:true,tasks:snapshot.tasks}
 })
 state.query.reinitialize=async()=>{}
 state.change({tasks:[{task_id:'pac-shell-1',task_type:'local_bash',description:'shell'}]})
 await state.barrier.snapshot()
 assert.deepEqual(state.events.at(-1).tasks.map(task=>task.task_id),['agent','pac-shell-1'])
 assert.equal(state.releases,1)
})

test('SDK timeout cannot release the shared lease while reinitialize remains in flight',async()=>{
 let finish, started
 const entered=new Promise(resolve=>{started=resolve})
 const state=setup(async ({query,sourceSessionId,lease})=>{
  const sdk=createSdkSnapshotBarrier({query,sdkSessionId:sourceSessionId,timeoutMs:30,publish:()=>{},acquireQuiescence:()=>({valid:()=>lease.valid(),release:()=>{}})})
  try {
   const snapshot=await sdk.snapshot()
   return {query,sourceSessionId,complete:true,tasks:snapshot.tasks}
  } catch(error) { await sdk.whenSettled(); throw error }
 },500)
 state.query.reinitialize=()=>new Promise(resolve=>{finish=resolve;started()})
 const pending=state.barrier.snapshot()
 await entered;await delay(60)
 assert.equal(state.held,true);assert.equal(state.releases,0)
 await assert.rejects(state.barrier.snapshot(),/unavailable/)
 finish();await assert.rejects(pending,/timed out/)
 assert.equal(state.held,false);assert.equal(state.releases,1)
 assert.equal(state.events.some(value=>value.availability==='ready'),false)
})
