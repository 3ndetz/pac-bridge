import { query } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSdkSnapshotBarrier, installSdkSnapshotTap } from '../../src/sdk-background-barrier.mjs'
if (process.env.PAC_TEST_SDK_SNAPSHOT !== '1') throw new Error('Explicit SDK capability test opt-in required')
const root=await mkdtemp(join(tmpdir(),'pac-sdk-snapshot-')), sessionId=randomUUID(), controller=new AbortController()
async function* input() { await new Promise(resolve=>controller.signal.addEventListener('abort',resolve,{once:true})) }
const env={...process.env,HOME:root,USERPROFILE:root,CLAUDE_CONFIG_DIR:join(root,'claude'),CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',ANTHROPIC_API_KEY:'',ANTHROPIC_AUTH_TOKEN:''}
let q, pump, firstSnapshot, snapshotResolve, phase='initial', initObserved=false, barrier, uninstall
const observed=new Promise(resolve=>{snapshotResolve=resolve})
const deadline=(promise,ms)=>Promise.race([promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('SDK probe timed out')),ms);timer.unref()})])
try {
 q=query({prompt:input(),options:{cwd:root,sessionId,env,settingSources:[],abortController:controller}})
 barrier=createSdkSnapshotBarrier({query:q,sdkSessionId:sessionId,timeoutMs:10000,publish:()=>{},acquireQuiescence:()=>({valid:()=>!controller.signal.aborted,release:()=>{}})})
 uninstall=installSdkSnapshotTap(q,(owner,message)=>barrier.observe(owner,message))
 pump=(async()=>{while(true){const {value:message,done}=await q.next();if(done)break;if(message.type==='system'&&message.subtype==='init')initObserved=message.session_id===sessionId;if(message.type==='system'&&message.subtype==='background_tasks_changed'){firstSnapshot={owner:message.session_id===sessionId,count:Array.isArray(message.tasks)?message.tasks.length:-1,phase};snapshotResolve()}}})()
 await deadline(q.initializationResult(),20000)
 phase='reinitializing'
 const ready=await deadline(barrier.snapshot(),20000)
 phase='after-response'
 if(ready.availability!=='ready'||ready.tasks.length!==0)throw new Error('SDK barrier rejected empty snapshot')
 await deadline(observed,10000)
 if(!firstSnapshot.owner||firstSnapshot.count!==0)throw new Error('Unexpected SDK startup snapshot')
 console.log(JSON.stringify({initObserved,emitsEmptySnapshot:true,sessionMatches:true,barrierAcceptedAfterResponse:true,pumpPhase:firstSnapshot.phase}))
} catch (error) {
 console.log(JSON.stringify({probeFailure: error?.message === 'SDK snapshot barrier timed out' ? 'barrier-timeout' : error?.message === 'SDK probe timed out' ? 'probe-timeout' : 'other'}))
 throw error
} finally {
 barrier?.close(); uninstall?.(); controller.abort(); q?.close(); await Promise.race([pump?.catch(()=>{}),new Promise(resolve=>setTimeout(resolve,3000))]); await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:200})
}
