import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { spawnContained, stopContained } from '../src/spawn-contained.mjs'

test('isolated local SDK reports its repeated-initialize snapshot capability', {skip:process.env.PAC_TEST_SDK_SNAPSHOT !== '1',timeout:70000}, async () => {
 const child=spawnContained(process.execPath,[fileURLToPath(new URL('./fixtures/sdk-snapshot-capability.mjs',import.meta.url))],{cwd:process.cwd(),env:{...process.env,PAC_TEST_SDK_SNAPSHOT:'1'},stdio:['ignore','pipe','pipe'],windowsHide:true})
 child.on('error',()=>{});let output='';child.stdout.on('data',chunk=>{output+=chunk});child.stderr.resume()
 const closed=new Promise(resolve=>child.once('close',(code)=>resolve(code)))
 try {
  let timer
  const code=await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('SDK capability process timed out')),60000)})]).finally(()=>clearTimeout(timer))
  if(code!==0) { const summary=JSON.parse(output.trim().split(/\r?\n/).at(-1)); throw new Error(`SDK capability probe failed: ${summary.probeFailure || 'unknown'}`) }
  const result=JSON.parse(output.trim().split(/\r?\n/).at(-1))
  assert.equal(result.sessionMatches,true);assert.equal(result.emitsEmptySnapshot,true)
  assert.equal(result.barrierAcceptedAfterResponse,true)
  console.log(`SDK capability: owned empty snapshot passed post-response barrier; init frame observed=${result.initObserved}`)
 } finally { stopContained(child); await closed }
})
