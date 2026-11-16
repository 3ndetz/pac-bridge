import test from 'node:test'
import assert from 'node:assert/strict'
import { createBackgroundTerminal } from '../src/background-terminal.mjs'

function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}

test('in-flight creation makes the snapshot incomplete and abort cleanup is verified',async()=>{
 const created=deferred(),releasing=deferred(),abort=new AbortController()
 const terminal={create:()=>created.promise,release:()=>releasing.promise}
 const bg=createBackgroundTerminal({terminal,sessionId:'owner'})
 const start=bg.start({sessionId:'owner'},{signal:abort.signal})
 assert.deepEqual({...bg.snapshotState(),revision:0},{tasks:[],starting:1,uncertain:0,complete:false,revision:0})
 abort.abort();created.resolve({terminalId:'terminal'})
 await new Promise(resolve=>setImmediate(resolve));assert.equal(bg.snapshotState().complete,false)
 releasing.resolve();await assert.rejects(start,/cancelled/)
 assert.equal(bg.snapshotState().complete,true)
})

test('a confirmed result survives uncertain release and snapshot remains incomplete',async()=>{
 const done=deferred(),releasing=deferred()
 const terminal={create:async()=>({terminalId:'t'}),waitForExit:()=>done.promise,output:()=>({output:'result'}),release:()=>releasing.promise}
 const bg=createBackgroundTerminal({terminal,sessionId:'owner'})
 const {taskId}=await bg.start({sessionId:'owner'});done.resolve({exitCode:0,signal:null})
 await new Promise(resolve=>setImmediate(resolve));assert.equal(bg.snapshotState().complete,false)
 releasing.reject(new Error('unconfirmed release'))
 const result=await bg.output({sessionId:'owner',taskId,block:true})
 assert.equal(result.status,'completed');assert.equal(result.output,'result');assert.equal(result.exitStatus.exitCode,0)
 assert.equal(bg.snapshotState().uncertain,1);assert.equal(bg.snapshotState().complete,false)
})

test('failed wait and release do not describe unknown outcome as a finished task',async()=>{
 const done=deferred()
 const terminal={create:async()=>({terminalId:'t'}),waitForExit:()=>done.promise,output:()=>({output:''}),release:async()=>{throw new Error('lost')}}
 const bg=createBackgroundTerminal({terminal,sessionId:'owner'})
 const {taskId}=await bg.start({sessionId:'owner'});done.reject(new Error('lost wait'))
 const result=await bg.output({sessionId:'owner',taskId,block:true})
 assert.equal(result.status,'unknown');assert.equal(bg.snapshotState().uncertain,1);assert.equal(bg.snapshotState().complete,false)
 assert.equal(bg.snapshot().some(task=>task.task_id===taskId),true)
 await assert.rejects(bg.stop({sessionId:'owner',taskId}),/unknown/)
})

test('failed creation, aborted cleanup, and lost change delivery stay uncertain',async()=>{
 const failCreate=createBackgroundTerminal({terminal:{create:async()=>{throw new Error('lost')}},sessionId:'owner'})
 await assert.rejects(failCreate.start({sessionId:'owner'}));assert.equal(failCreate.snapshotState().complete,false)
 const abort=new AbortController();abort.abort()
 const failedRelease=createBackgroundTerminal({terminal:{create:async()=>({terminalId:'t'}),release:async()=>{throw new Error('lost')}},sessionId:'owner'})
 await assert.rejects(failedRelease.start({sessionId:'owner'},{signal:abort.signal}));assert.equal(failedRelease.snapshotState().uncertain,1)
 const lostDelivery=createBackgroundTerminal({terminal:{create:async()=>({terminalId:'t'}),waitForExit:async()=>({exitCode:0}),output:()=>({output:'ok'}),release:async()=>{}},sessionId:'owner',onChange:()=>{throw new Error('lost')}})
 const {taskId}=await lostDelivery.start({sessionId:'owner'});await lostDelivery.output({sessionId:'owner',taskId,block:true})
 assert.equal(lostDelivery.snapshotState().complete,false)
})


test('unknown resources consume capacity until their cleanup is confirmed',async()=>{
 const done=deferred()
 const terminal={create:async()=>({terminalId:'t'}),waitForExit:()=>done.promise,output:()=>({output:''}),release:async()=>{throw new Error('lost')}}
 const bg=createBackgroundTerminal({terminal,sessionId:'owner',maxTasks:1})
 const {taskId}=await bg.start({sessionId:'owner'});done.reject(new Error('lost'))
 await bg.output({sessionId:'owner',taskId,block:true})
 await assert.rejects(bg.start({sessionId:'owner'}),/limit/)
})

test('failed stop stays uncertain while the process could still be running',async()=>{
 const done=deferred()
 const terminal={create:async()=>({terminalId:'t'}),waitForExit:()=>done.promise,output:()=>({output:'partial'}),kill:async()=>{throw new Error('unconfirmed kill')},release:async()=>{}}
 const bg=createBackgroundTerminal({terminal,sessionId:'owner'})
 const {taskId}=await bg.start({sessionId:'owner'})
 await assert.rejects(bg.stop({sessionId:'owner',taskId}),/unconfirmed/)
 assert.equal(bg.snapshotState().complete,false)
 assert.equal((await bg.output({sessionId:'owner',taskId,block:false})).status,'running')
 done.resolve({exitCode:0});assert.equal((await bg.output({sessionId:'owner',taskId,block:true})).status,'completed')
 assert.equal(bg.snapshotState().complete,true)
})

test('an output read failure keeps the confirmed exit status',async()=>{
 const terminal={create:async()=>({terminalId:'t'}),waitForExit:async()=>({exitCode:7,signal:null}),output:()=>{throw new Error('unavailable')},release:async()=>{}}
 const bg=createBackgroundTerminal({terminal,sessionId:'owner'})
 const {taskId}=await bg.start({sessionId:'owner'})
 const result=await bg.output({sessionId:'owner',taskId,block:true})
 assert.equal(result.status,'failed');assert.equal(result.exitStatus.exitCode,7);assert.match(result.error,/output is unavailable/)
 assert.equal(bg.snapshotState().complete,true)
})


test('does not publish an incomplete snapshot as an empty full set',async()=>{
 const created=deferred(),done=deferred(),full=[],uncertain=[]
 const terminal={create:()=>created.promise,waitForExit:()=>done.promise,output:()=>({output:''}),release:async()=>{}}
 const bg=createBackgroundTerminal({terminal,sessionId:'owner',onChange:tasks=>full.push(tasks),onUncertain:state=>uncertain.push(state)})
 const start=bg.start({sessionId:'owner'});assert.equal(full.length,0);assert.equal(uncertain.at(-1).starting,1)
 created.resolve({terminalId:'t'});await start
 assert.equal(full.at(-1).length,1);done.resolve({exitCode:0});await new Promise(resolve=>setImmediate(resolve))
 assert.deepEqual(full.at(-1),[])
})


test('a failed wait remains unknown even after release reports success',async()=>{
 const done=deferred()
 const terminal={create:async()=>({terminalId:'t'}),waitForExit:()=>done.promise,output:()=>({output:''}),release:async()=>{}}
 const bg=createBackgroundTerminal({terminal,sessionId:'owner',maxTasks:1})
 const {taskId}=await bg.start({sessionId:'owner'});done.reject(new Error('lost'))
 assert.equal((await bg.output({sessionId:'owner',taskId,block:true})).status,'unknown')
 assert.equal(bg.snapshotState().complete,false);assert.equal(bg.snapshotState().uncertain,1)
 assert.equal(bg.snapshot().some(task=>task.task_id===taskId),true)
 await assert.rejects(bg.start({sessionId:'owner'}),/limit/)
})


test('lost unknown notification latches unavailable and invokes transport failure once',async()=>{
 const created=deferred(),done=deferred(),events=[];let failed=0
 const terminal={create:()=>created.promise,waitForExit:()=>done.promise,output:()=>({output:''}),release:async()=>{}}
 const bg=createBackgroundTerminal({terminal,sessionId:'owner',onChange:tasks=>events.push(tasks),onUncertain:()=>{throw new Error('disconnected')},onDeliveryFailure:()=>{failed++}})
 const start=bg.start({sessionId:'owner'});created.resolve({terminalId:'t'});const {taskId}=await start
 done.resolve({exitCode:0});await bg.output({sessionId:'owner',taskId,block:true})
 assert.equal(failed,1);assert.equal(bg.snapshotState().complete,false);assert.deepEqual(events,[])
})

test('ready-to-incomplete invalidation closes a failed notification transport',async()=>{
 const {createUncertaintyNotifier}=await import('../src/pac-uncertainty-notifier.mjs')
 const created=deferred(),done=deferred(),events=[];let closed=0,fail=false
 const notifier=createUncertaintyNotifier({notify:value=>{if(fail)throw new Error('lost');events.push(value)},close:()=>{closed++}})
 const terminal={create:()=>created.promise,waitForExit:()=>done.promise,output:()=>({output:''}),release:async()=>{}}
 const bg=createBackgroundTerminal({terminal,sessionId:'owner',onChange:tasks=>events.push({availability:'ready',tasks}),onUncertain:()=>notifier.unknown({availability:'unknown'}),onDeliveryFailure:()=>notifier.failure()})
 const start=bg.start({sessionId:'owner'});created.resolve({terminalId:'t'});const {taskId}=await start
 assert.equal(events.at(-1).availability,'ready')
 fail=true;done.resolve({exitCode:0});await bg.output({sessionId:'owner',taskId,block:true})
 assert.equal(closed,1);assert.equal(notifier.failed,true);assert.equal(bg.snapshotState().complete,false)
})

test('ready-to-incomplete invalidation is emitted before a pending start completes',async()=>{
 const {createUncertaintyNotifier}=await import('../src/pac-uncertainty-notifier.mjs')
 const created=deferred(),events=[]
 const notifier=createUncertaintyNotifier({notify:value=>events.push(value),close:()=>{throw new Error('unexpected')}})
 const terminal={create:()=>created.promise,waitForExit:()=>new Promise(()=>{}),output:()=>({output:''}),release:async()=>{}}
 const bg=createBackgroundTerminal({terminal,sessionId:'owner',onChange:tasks=>events.push({availability:'ready',tasks}),onUncertain:()=>notifier.unknown({availability:'unknown'}),onDeliveryFailure:()=>notifier.failure()})
 events.push({availability:'ready',tasks:[]})
 const start=bg.start({sessionId:'owner'});assert.equal(events.at(-1).availability,'unknown')
 created.resolve({terminalId:'t'});await start
 assert.equal(events.at(-1).availability,'ready')
})
