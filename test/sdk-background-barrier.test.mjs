import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createSdkSnapshotBarrier } from '../src/sdk-background-barrier.mjs'

function make({reinitialize=async()=>{},timeoutMs=80}={}) {
  const query={reinitialize}, events=[]
  let held=false, releases=0, valid=true
  const barrier=createSdkSnapshotBarrier({query,sdkSessionId:'source-session',timeoutMs,publish:value=>events.push(value),acquireQuiescence:()=>{if(held)return null;held=true;return {valid:()=>valid,release:()=>{held=false;releases++}}}})
  return {query,events,barrier,get held(){return held},get releases(){return releases},invalidate(){valid=false}}
}
const snapshot = (tasks=[]) => ({type:'system',subtype:'background_tasks_changed',session_id:'source-session',tasks})
const task = (run='run-1') => ({task_id:'child',run_id:run,task_type:'local_agent',description:'research',secret:'not forwarded'})

test('barrier accepts a full owned snapshot after initialization and preserves run identity', async () => {
  const state=make(), result=state.barrier.snapshot()
  await delay(1)
  state.barrier.observe(state.query,snapshot([task()]))
  const ready=await result
  assert.equal(ready.availability,'ready')
  assert.deepEqual(ready.tasks,[{task_id:'child',run_id:'run-1',task_type:'local_agent',description:'research'}])
  assert.equal(state.releases,1); assert.equal(JSON.stringify(ready).includes('not forwarded'),false)
})

test('old CLI silence and pre-response snapshots remain unknown', async () => {
  let finish
  const state=make({reinitialize:()=>new Promise(resolve=>{finish=resolve}),timeoutMs:30})
  const result=state.barrier.snapshot()
  state.barrier.observe(state.query,snapshot([])); finish()
  await assert.rejects(result,/timed out/)
  assert.equal(state.events.at(-1).availability,'unknown'); assert.equal(state.held,false)
})

test('a stalled reinitialize keeps the quiescence lease after timeout until it settles', async () => {
  let finish
  const state=make({reinitialize:()=>new Promise(resolve=>{finish=resolve}),timeoutMs:30})
  await assert.rejects(state.barrier.snapshot(),/timed out/)
  assert.equal(state.held,true)
  await assert.rejects(state.barrier.snapshot(),/unavailable/)
  finish(); await delay(5)
  assert.equal(state.held,false); assert.equal(state.releases,1)
  assert.equal(state.events.at(-1).availability,'unknown')
})

test('foreign query, session, duplicate ID, or invalidated lease cannot establish ready', async () => {
  const state=make(), result=state.barrier.snapshot()
  await delay(1)
  assert.throws(()=>state.barrier.observe({},snapshot([])),/Unowned/)
  assert.throws(()=>state.barrier.observe(state.query,{...snapshot([]),session_id:'other'}),/Foreign/)
  assert.throws(()=>state.barrier.observe(state.query,snapshot([task(),task()])),/Invalid/)
  state.invalidate(); state.barrier.observe(state.query,snapshot([]))
  await assert.rejects(result,/timed out/)
  assert.equal(state.events.some(event=>event.availability==='ready'),false)
})

test('resumed task run is distinct and absent run identity remains absent', async () => {
  const state=make()
  for (const tasks of [[task('run-1')],[task('run-2')],[{task_id:'child',task_type:'local_agent',description:''}]]) {
    const result=state.barrier.snapshot(); await delay(1); state.barrier.observe(state.query,snapshot(tasks)); await result
  }
  const ready=state.events.filter(event=>event.availability==='ready')
  assert.equal(ready[0].tasks[0].run_id,'run-1'); assert.equal(ready[1].tasks[0].run_id,'run-2')
  assert.equal(Object.hasOwn(ready[2].tasks[0],'run_id'),false)
})


test('a later frame before delivery invalidates an earlier candidate', async () => {
  const state=make(), result=state.barrier.snapshot()
  await delay(1)
  state.barrier.observe(state.query,snapshot([task()]))
  assert.throws(()=>state.barrier.observe(state.query,{...snapshot([]),session_id:'foreign'}),/Foreign/)
  await assert.rejects(result,/invalidated/)
  assert.equal(state.events.some(event=>event.availability==='ready'),false)
})

test('tap observes the existing consumer without issuing a second next', async () => {
  const { installSdkSnapshotTap }=await import('../src/sdk-background-barrier.mjs')
  let calls=0, release
  const value=snapshot([task()]), query={next(){calls++;return new Promise(resolve=>{release=resolve})}}, seen=[]
  const original=query.next, uninstall=installSdkSnapshotTap(query,(owner,message)=>seen.push({owner,message}))
  const waiting=query.next(); assert.equal(calls,1); assert.equal(seen.length,0)
  release({done:false,value}); assert.deepEqual(await waiting,{done:false,value}); assert.equal(calls,1); assert.equal(seen[0].owner,query)
  uninstall(); assert.equal(query.next,original)
})

test('a later SDK snapshot invalidates previously published readiness',async()=>{
 const state=make(), result=state.barrier.snapshot()
 await delay(1);state.barrier.observe(state.query,snapshot([task()]));await result
 assert.equal(state.events.at(-1).availability,'ready')
 state.barrier.observe(state.query,snapshot([]))
 assert.equal(state.events.at(-1).availability,'unknown')
})

test('a removed tap ignores an already pending next', async () => {
  const { installSdkSnapshotTap }=await import('../src/sdk-background-barrier.mjs')
  let release, seen=0
  const query={next(){return new Promise(resolve=>{release=resolve})}}, uninstall=installSdkSnapshotTap(query,()=>{seen++})
  const waiting=query.next(); uninstall(); release({done:false,value:snapshot([])}); await waiting
  assert.equal(seen,0)
})
