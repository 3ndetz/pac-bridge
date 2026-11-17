import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { spawnContained, stopContained } from '../src/spawn-contained.mjs'

test('real local SDK and synthetic source operations share a quiescence lease', {skip:process.env.PAC_TEST_SDK_COORDINATED !== '1',timeout:70000}, async()=>{
 const fixture=fileURLToPath(new URL('./fixtures/sdk-coordinated-runtime.mjs',import.meta.url))
 const child=spawnContained(process.execPath,[fixture],{cwd:process.cwd(),env:{...process.env,PAC_TEST_SDK_COORDINATED:'1'},stdio:['ignore','pipe','pipe'],windowsHide:true})
 child.on('error',()=>{});let output='';child.stdout.on('data',chunk=>{output=(output+chunk).slice(-8192)});child.stderr.resume()
 const closed=new Promise(resolve=>child.once('close',code=>resolve(code)))
 let timer
 try {
  const code=await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('SDK runtime fixture timed out')),60000)})])
  assert.equal(code,0,'Owned SDK runtime fixture failed')
  assert.deepEqual(JSON.parse(output.trim().split(/\r?\n/).at(-1)),{sdkSnapshot:true,distinctIdentities:true,blockedOperations:7,blockedSnapshots:7,autonomousPreemption:true,terminalLifecycle:true,lossInvalidated:true})
 } finally {clearTimeout(timer);stopContained(child);await closed}
})
