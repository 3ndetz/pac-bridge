import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openOpencodeAcpSession } from '../src/opencode-acp-session.mjs'
import { spawnContained, stopContained } from '../src/spawn-contained.mjs'

async function waitForExit(pid) {
  const deadline = Date.now() + 15000
  for (;;) {
    try { process.kill(pid,0) } catch (error) { if (error.code === 'ESRCH') return; throw error }
    if (Date.now() >= deadline) throw new Error('Owned child did not exit')
    await new Promise(resolve=>setTimeout(resolve,50))
  }
}

for (const beforeEpoch of [false, true]) test(`invalidates ${beforeEpoch ? 'before the first epoch' : 'ready'} after notification failure with a live child`, { skip: process.platform !== 'linux', timeout:30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(),'pac-live-disconnect-'))
  const fixture = fileURLToPath(new URL('./fixtures/fake-acp-live-disconnect.mjs', import.meta.url))
  const updates = []
  let resolveUnknown
  const unknown = new Promise(resolve=>{resolveUnknown=resolve})
  let session, pid
  try {
    session = await openOpencodeAcpSession({command:process.execPath,args:[fixture],cwd:root,env:{...process.env,PAC_TEST_PID_FILE:join(root,'pid'),...(beforeEpoch ? {PAC_TEST_BEFORE_EPOCH:'1'} : {})},model:'PAC_test/sonnet',onPermission:async()=>({}),onBackgroundAvailability:value=>{updates.push(value);if(value.availability === 'unknown') resolveUnknown()}})
    pid = Number(await readFile(join(root,'pid'),'utf8'))
    if (!beforeEpoch) {
      await session.requestBackgroundSnapshot()
      await session.prompt([],()=>{})
      assert.equal(updates.at(-1).availability,'ready')
    }
    await assert.rejects(session.prompt([],()=>{}),/another session|connection lost/i)
    let timer
    try { await Promise.race([unknown,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('No availability invalidation')),5000)})]) } finally { clearTimeout(timer) }
    await assert.rejects(session.stopTask('task'),/connection.*closed|connection lost/i)
    assert.doesNotThrow(()=>process.kill(pid,0))
    assert.deepEqual(updates.at(-1),{rootSessionId:'root',epoch:beforeEpoch ? null : 'e8b00b0c-1f7c-40ce-80c8-b3f7d3313720',availability:'unknown'})
    const count = updates.length
    session.close(); session.close()
    await waitForExit(pid)
    assert.equal(updates.length,count)
    assert.equal(updates.filter(value=>value.availability === 'unknown').length,1)
  } finally {
    session?.close()
    if (pid) await waitForExit(pid)
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:200})
  }
})

test('stdout EOF invalidates availability in an isolated injected transport', { skip: process.platform !== 'linux', timeout:60000 }, async () => {
  const fixture = fileURLToPath(new URL('./fixtures/acp-session-eof-injected.mjs',import.meta.url))
  const env = {...process.env}
  delete env.NODE_TEST_CONTEXT
  const child = spawnContained(process.execPath,['--experimental-test-module-mocks','--test',fixture],{env,stdio:['ignore','pipe','pipe'],windowsHide:true})
  child.on('error',()=>{})
  let output = ''
  for (const stream of [child.stdout,child.stderr]) stream.on('data',chunk=>{output=(output+chunk).slice(-32000)})
  const closed = new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})))
  let timer
  try {
    const result = await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Injected EOF tests timed out')),45000)})])
    assert.equal(result.code,0,output)
    assert.match(output,/pass 2/)
  } finally {
    clearTimeout(timer)
    stopContained(child)
    await closed
  }
})
