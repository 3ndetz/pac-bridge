import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { spawnContained, stopContained } from '../src/spawn-contained.mjs'

test('binds a real ACP agent session to its owned SDK query', {skip:process.env.PAC_TEST_SDK_ACP_BINDING!=='1',timeout:90000}, async()=>{
 const child=spawnContained(process.execPath,[fileURLToPath(new URL('./fixtures/sdk-acp-binding-runtime.mjs',import.meta.url))],{env:{...process.env,PAC_TEST_SDK_ACP_BINDING:'1'},stdio:['ignore','pipe','pipe'],windowsHide:true})
 child.on('error',()=>{});let output='';child.stdout.on('data',chunk=>{output=(output+chunk).slice(-8192)});child.stderr.resume()
 const closed=new Promise(resolve=>child.once('close',code=>resolve(code)))
 let timer
 try {
  const code=await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('ACP binding probe timed out')),80000)})])
  const result=JSON.parse(output.trim().split(/\r?\n/).at(-1))
  if(code!==0)throw new Error(`ACP binding probe failed at ${result.probeFailure || 'unknown'} (${result.category || 'unknown'}, ${result.errorType || 'unknown'}, site ${result.site || 'unknown'})`)
  for(const key of ['agentSession','ownedQuery','observedSdkIdentity','postResponseSnapshot','coordinatedTerminal','realPermissionCallback','concurrentPermission','replacementRejected'])assert.equal(result[key],true)
  assert.equal(result.blockedSnapshots,4)
  assert.equal(typeof result.sameIds,'boolean')
  console.log(`ACP/SDK identifiers equal: ${result.sameIds}`)
 } finally {clearTimeout(timer);stopContained(child);await closed}
})
