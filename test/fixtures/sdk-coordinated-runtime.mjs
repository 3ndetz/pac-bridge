import { query } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSdkSnapshotBarrier, installSdkSnapshotTap } from '../../src/sdk-background-barrier.mjs'
import { createCoordinatedSourceBarrier } from '../../src/sdk-source-barrier.mjs'
import { createSourceQuiescence } from '../../src/pac-source-quiescence.mjs'
import { createBackgroundTerminal } from '../../src/background-terminal.mjs'
import { createPacSourceBinding } from '../../src/pac-source-binding.mjs'

if (process.env.PAC_TEST_SDK_COORDINATED !== '1') throw new Error('Explicit SDK runtime test opt-in required')
const root=await mkdtemp(join(tmpdir(),'pac-sdk-coordinated-')), sourceSessionId=randomUUID(), abort=new AbortController(), events=[]
const env={...process.env,HOME:root,USERPROFILE:root,CLAUDE_CONFIG_DIR:join(root,'claude'),CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',ANTHROPIC_API_KEY:'',ANTHROPIC_AUTH_TOKEN:''}
async function* input(){await new Promise(resolve=>abort.signal.addEventListener('abort',resolve,{once:true}))}
let q,pump,sdk,composite,uninstall,binding,enterCapture,releaseCapture
const entered=new Promise(resolve=>{enterCapture=resolve}), proceed=new Promise(resolve=>{releaseCapture=resolve})
const gate=createSourceQuiescence({onInvalidate:()=>composite?.invalidate()})
let finishTerminal
const rootSessionId='synthetic-acp-root'
const terminal=createBackgroundTerminal({sessionId:rootSessionId,terminal:{
  create:async()=>({terminalId:'owned-terminal'}),
  waitForExit:()=>new Promise(resolve=>{finishTerminal=()=>resolve({exitCode:0})}),
  output:()=>({output:'synthetic'}),release:async()=>{},kill:async()=>{},
},onChange:()=>composite?.invalidate(),onUncertain:()=>composite?.invalidate(),onDeliveryFailure:()=>gate.close()})
const timeout=(promise,ms)=>Promise.race([promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('SDK runtime test timed out')),ms);timer.unref()})])
try {
 q=query({prompt:input(),options:{cwd:root,sessionId:sourceSessionId,env,settingSources:[],abortController:abort}})
 const session={query:q},agent={sessions:{[rootSessionId]:session}}
 binding=createPacSourceBinding({agent,rootSessionId,sdkSessionId:sourceSessionId,query:q,onInvalidated:()=>composite?.invalidate()})
 uninstall=installSdkSnapshotTap(q,(owner,message)=>{binding.observe(owner,message);sdk?.observe(owner,message)})
 pump=(async()=>{while(!(await q.next()).done){}})()
 await timeout(q.initializationResult(),20000)
 const reinitialize=q.reinitialize.bind(q)
 let pauseFirst=true
 q.reinitialize=(...args)=>{
   const operation=reinitialize(...args)
   if(!pauseFirst)return operation
   pauseFirst=false;enterCapture()
   return Promise.resolve(operation).then(async value=>{await proceed;return value})
 }
 composite=createCoordinatedSourceBarrier({sourceSessionId,query:q,terminals:terminal,timeoutMs:20000,acquireQuiescence:()=>{
   const lease=gate.acquire()
   return lease ? {valid:()=>lease.valid() && binding.owned(),release:()=>lease.release()} : null
 },publish:value=>events.push(value),onDeliveryFailure:()=>gate.close(),captureSdk:async({query:actual,sourceSessionId:id,lease})=>{
   sdk=createSdkSnapshotBarrier({query:actual,sdkSessionId:id,timeoutMs:10000,publish:()=>{},acquireQuiescence:()=>({valid:()=>lease.valid(),release:()=>{}})})
   try {const result=await sdk.snapshot();if(!binding.trusted())throw new Error('SDK identity not confirmed');return {query:actual,sourceSessionId:id,complete:true,tasks:result.tasks}}
   catch(error){await sdk.whenSettled();throw error}
 }})
 for(const kind of ['turn','hook','permission','terminal','mcp','sdk_callback','control']) {
   const finish=gate.enter(kind)
   try {await composite.snapshot();throw new Error('Snapshot accepted during source operation')} catch(error) {if(!/quiescent/.test(error.message))throw error}
   finally {finish()}
 }
 const pending=composite.snapshot();await entered
 for(const kind of ['turn','hook','permission','terminal','mcp','sdk_callback','control']) {
   let blocked=false
   try {gate.enter(kind)} catch {blocked=true}
   if(!blocked)throw new Error('Source operation entered during snapshot')
 }
 const autonomous=gate.enterExternal('sdk_callback')
 if(events.at(-1)?.availability!=='unknown')throw new Error('Autonomous callback did not invalidate snapshot')
 releaseCapture()
 let rejected=false
 try {await timeout(pending,20000)} catch {rejected=true}
 if(!rejected || events.some(value=>value.availability==='ready'))throw new Error('Invalidated SDK snapshot was accepted')
 autonomous()
 await timeout(composite.snapshot(),20000)
 const ready=events.at(-1)
 if(ready?.availability!=='ready' || ready.tasks.length!==0)throw new Error('Unexpected test SDK result')
 const endTerminal=gate.enter('terminal')
 const task=await terminal.start({sessionId:rootSessionId,description:'synthetic'})
 endTerminal()
 await timeout(composite.snapshot(),20000)
 if(events.at(-1)?.availability!=='ready' || events.at(-1).tasks.length!==1 || events.at(-1).tasks[0].task_id!==task.taskId)throw new Error('Terminal snapshot was not included')
 finishTerminal()
 await terminal.output({sessionId:rootSessionId,taskId:task.taskId,block:true,timeoutMs:1000})
 if(events.at(-1)?.availability!=='unknown')throw new Error('Terminal completion was not invalidated')
 gate.invalidate()
 if(events.at(-1)?.availability!=='unknown')throw new Error('Loss was not invalidated')
 session.query={}
 if(binding.owned())throw new Error('Replaced query kept its binding')
 console.log(JSON.stringify({sdkSnapshot:true,distinctIdentities:true,blockedOperations:7,blockedSnapshots:7,autonomousPreemption:true,terminalLifecycle:true,lossInvalidated:true}))
} finally {
 releaseCapture?.();sdk?.close();composite?.close();gate.close();binding?.close();uninstall?.();abort.abort();q?.close()
 await Promise.race([pump?.catch(()=>{}),new Promise(resolve=>setTimeout(resolve,3000))])
 await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:200})
}
