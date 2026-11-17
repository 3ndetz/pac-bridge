import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSdkSnapshotBarrier, installSdkSnapshotTap } from '../../src/sdk-background-barrier.mjs'
import { createPacSourceBinding } from '../../src/pac-source-binding.mjs'
import { createSourceQuiescence } from '../../src/pac-source-quiescence.mjs'
import { createCoordinatedSourceBarrier } from '../../src/sdk-source-barrier.mjs'
import { createBackgroundTerminal } from '../../src/background-terminal.mjs'

if (process.env.PAC_TEST_SDK_ACP_BINDING !== '1') throw new Error('Explicit ACP binding test opt-in required')
const root=await mkdtemp(join(tmpdir(),'pac-sdk-acp-binding-'))
Object.assign(process.env,{HOME:root,USERPROFILE:root,CLAUDE_CONFIG_DIR:join(root,'claude'),CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',ANTHROPIC_API_KEY:'',ANTHROPIC_AUTH_TOKEN:''})
const deadline=(promise,ms)=>Promise.race([promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('ACP binding probe timed out')),ms);timer.unref()})])
const logger={log(){},debug(){},info(){},warn(){},error(){}}
const client=new Proxy({}, {get:()=>async()=>({})})
let agent,pump,q,binding,barrier,uninstall,coordinator,gate,phase='start'
try {
 const {ClaudeAcpAgent}=await import('@agentclientprotocol/claude-agent-acp/dist/acp-agent.js')
 agent=new ClaudeAcpAgent(client,logger)
 agent.sendAvailableCommandsUpdate=async()=>{}
 await deadline(agent.initialize({protocolVersion:1,clientCapabilities:{}}),20000)
 phase='new-session'
 const opened=await deadline(agent.newSession({cwd:root,mcpServers:[],_meta:{claudeCode:{options:{settingSources:[]}}}}),30000)
 const rootSessionId=opened.sessionId,session=agent.sessions[rootSessionId]
 q=session?.query
 if(!q || session.queryClosed)throw new Error('ACP query unavailable')
 let firstResolve
 const first=new Promise(resolve=>{firstResolve=resolve})
 uninstall=installSdkSnapshotTap(q,(owner,message)=>{
   if(message?.type==='system' && message?.subtype==='background_tasks_changed')firstResolve({owner,sessionId:message.session_id,message})
   binding?.observe(owner,message)
   barrier?.observe(owner,message)
 })
 pump=(async()=>{while(!(await q.next()).done){}})()
 phase='identity'
 await deadline(q.reinitialize(),20000)
 const witness=await deadline(first,10000)
 if(witness.owner!==q || typeof witness.sessionId!=='string' || !witness.sessionId)throw new Error('SDK identity unavailable')
 binding=createPacSourceBinding({agent,rootSessionId,sdkSessionId:witness.sessionId,query:q,onInvalidated:()=>coordinator?.invalidate()})
 binding.observe(witness.owner,witness.message)
 barrier=createSdkSnapshotBarrier({query:q,sdkSessionId:witness.sessionId,timeoutMs:10000,publish:()=>{},acquireQuiescence:()=>({valid:()=>binding.owned(),release:()=>{}})})
 phase='barrier'
 const result=await deadline(barrier.snapshot(),20000)
 if(!binding.trusted() || result.availability!=='ready' || result.tasks.length!==0)throw new Error('ACP SDK binding rejected')
 phase='coordinator'
 const events=[]
 gate=createSourceQuiescence({onInvalidate:()=>coordinator?.invalidate()})
 let finishTerminal
 const terminals=createBackgroundTerminal({sessionId:rootSessionId,terminal:{create:async()=>({terminalId:'terminal'}),waitForExit:()=>new Promise(resolve=>{finishTerminal=()=>resolve({exitCode:0})}),output:()=>({output:''}),release:async()=>{},kill:async()=>{}},onChange:()=>coordinator?.invalidate(),onUncertain:()=>coordinator?.invalidate(),onDeliveryFailure:()=>gate.close()})
 coordinator=createCoordinatedSourceBarrier({sourceSessionId:witness.sessionId,query:q,terminals,acquireQuiescence:()=>{const lease=gate.acquire();return lease?{valid:()=>lease.valid()&&binding.owned(),release:()=>lease.release()}:null},publish:value=>events.push(value),onDeliveryFailure:()=>gate.close(),captureSdk:async({query:actual,sourceSessionId:id,lease})=>{
   barrier=createSdkSnapshotBarrier({query:actual,sdkSessionId:id,timeoutMs:10000,publish:value=>{if(value.availability==='unknown')coordinator.invalidate()},acquireQuiescence:()=>({valid:()=>lease.valid(),release:()=>{}})})
   try {const snap=await barrier.snapshot();if(!binding.trusted())throw new Error('SDK binding lost');return {query:actual,sourceSessionId:id,complete:true,tasks:snap.tasks}}
   catch(error){await barrier.whenSettled();throw error}
 }})
 for(const kind of ['turn','hook','permission','terminal']) {
   const end=gate.enter(kind)
   try {await coordinator.snapshot();throw new Error('Snapshot accepted active operation')} catch(error) {if(!/quiescent/.test(error.message))throw error} finally {end()}
 }
 const done=gate.enter('terminal'),task=await terminals.start({sessionId:rootSessionId,description:'synthetic'})
 done();await deadline(coordinator.snapshot(),20000)
 if(events.at(-1)?.availability!=='ready' || events.at(-1).tasks.length!==1 || events.at(-1).tasks[0].task_id!==task.taskId)throw new Error('Combined snapshot invalid')
 finishTerminal();await terminals.output({sessionId:rootSessionId,taskId:task.taskId,block:true,timeoutMs:1000})
 if(events.at(-1)?.availability!=='unknown')throw new Error('Terminal invalidation missing')
 await deadline(coordinator.snapshot(),20000)
 if(events.at(-1)?.availability!=='ready')throw new Error('Empty test snapshot not ready')
 barrier.observe(q,witness.message)
 if(events.at(-1)?.availability!=='unknown')throw new Error('SDK update was not invalidated')
 await deadline(coordinator.snapshot(),20000)
 if(events.at(-1)?.availability!=='ready')throw new Error('Repeat test snapshot not ready')
 let enterPermission,resolvePermission
 const permissionEntered=new Promise(resolve=>{enterPermission=resolve})
 const permissionResult=new Promise(resolve=>{resolvePermission=resolve})
 agent.requestPermissionFromClient=async request=>{enterPermission(request.options);return await permissionResult}
 const permission=gate.wrapExternal('permission',agent.canUseTool(rootSessionId))
 const permissionPending=permission('Read',{file_path:join(root,'synthetic')},{signal:new AbortController().signal,toolUseID:'synthetic-permission'})
 const choices=await deadline(permissionEntered,5000)
 if(events.at(-1)?.availability!=='unknown' || gate.acquire()!==null)throw new Error('Permission callback did not revoke snapshot')
 resolvePermission({outcome:{outcome:'selected',optionId:choices[0].optionId}})
 await deadline(permissionPending,5000)
 await deadline(coordinator.snapshot(),20000)
 if(events.at(-1)?.availability!=='ready')throw new Error('Snapshot did not recover after permission callback')
 let announceControl,releaseControl,announcePermission,resolveConcurrentPermission
 const controlStarted=new Promise(resolve=>{announceControl=resolve}),controlRelease=new Promise(resolve=>{releaseControl=resolve})
 const concurrentEntered=new Promise(resolve=>{announcePermission=resolve}),concurrentReply=new Promise(resolve=>{resolveConcurrentPermission=resolve})
 const originalReinitialize=q.reinitialize
 phase='concurrent-control'
 q.reinitialize=function(...args){const request=originalReinitialize.apply(q,args);announceControl();return Promise.resolve(request).then(async value=>{await controlRelease;return value})}
 agent.requestPermissionFromClient=async request=>{announcePermission(request.options);return await concurrentReply}
 const beforeConcurrent=events.length,concurrentSnapshot=coordinator.snapshot().then(()=>false,()=>true)
 await deadline(controlStarted,5000)
 const concurrentPermission=gate.wrapExternal('permission',agent.canUseTool(rootSessionId))('Read',{file_path:join(root,'synthetic')},{signal:new AbortController().signal,toolUseID:'concurrent-permission'})
 phase='concurrent-permission'
 const concurrentChoices=await deadline(concurrentEntered,5000)
 if(events.at(-1)?.availability!=='unknown')throw new Error('Concurrent permission did not invalidate snapshot')
 resolveConcurrentPermission({outcome:{outcome:'selected',optionId:concurrentChoices[0].optionId}})
 await deadline(concurrentPermission,5000)
 releaseControl()
 phase='concurrent-settle'
 const rejected=await deadline(concurrentSnapshot,20000)
 q.reinitialize=originalReinitialize
 if(!rejected || events.slice(beforeConcurrent).some(value=>value.availability==='ready'))throw new Error('Concurrent permission left snapshot ready')
 const original=session.query;session.query={}
 if(binding.owned())throw new Error('Replaced ACP query kept ownership')
 if(events.at(-1)?.availability!=='unknown')throw new Error('Query replacement was not invalidated')
 session.query=original
 console.log(JSON.stringify({agentSession:true,ownedQuery:true,observedSdkIdentity:true,postResponseSnapshot:true,coordinatedTerminal:true,realPermissionCallback:true,concurrentPermission:true,blockedSnapshots:4,replacementRejected:true,sameIds:rootSessionId===witness.sessionId}))
} catch(error) {
 const text=String(error?.message || '')
 const category=['authentication','login','api key','credential','session','capabilit','client','cwd','model','initialize','permission'].find(value=>text.toLowerCase().includes(value)) || 'other'
 const site=String(error?.stack || '').match(/acp-agent\.js:(\d+):\d+/)?.[1] || 'other'
 console.log(JSON.stringify({probeFailure:phase,category,errorType:error?.name || 'Error',site}))
 throw error
} finally {
 barrier?.close();coordinator?.close();gate?.close();binding?.close();uninstall?.();q?.close();await Promise.race([pump?.catch(()=>{}),new Promise(resolve=>setTimeout(resolve,3000))]);await agent?.dispose();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:200})
}
