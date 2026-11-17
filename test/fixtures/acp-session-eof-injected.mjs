import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

let child, closed
mock.module(new URL('../../src/spawn-contained.mjs', import.meta.url), { namedExports: {
  spawnContained(command,args,options) {
    child = spawn(command,args,options)
    closed = new Promise(resolve=>child.once('close',resolve))
    return child
  },
  stopContained(target) { if (target.exitCode === null && target.signalCode === null) target.kill() },
} })
const { openOpencodeAcpSession } = await import('../../src/opencode-acp-session.mjs')

for (const beforeEpoch of [false,true]) test(`stdout EOF ${beforeEpoch ? 'before first epoch' : 'after ready'}`, {timeout:30000}, async () => {
  const root = await mkdtemp(join(tmpdir(),'pac-eof-injected-'))
  const updates = []
  let resolveUnknown, session
  const unknown = new Promise(resolve=>{resolveUnknown=resolve})
  try {
    const fixture = fileURLToPath(new URL('./fake-acp-live-eof.py',import.meta.url))
    const python = process.env.PAC_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
    session = await openOpencodeAcpSession({command:python,args:['-u',fixture],cwd:root,env:{...process.env,PAC_TEST_PID_FILE:join(root,'pid'),...(beforeEpoch ? {PAC_TEST_BEFORE_EPOCH:'1'} : {})},model:'PAC_test/sonnet',onPermission:async()=>({}),onBackgroundAvailability:value=>{updates.push(value);if(value.availability === 'unknown') resolveUnknown()}})
    if (!beforeEpoch) {
      await session.requestBackgroundSnapshot()
      await session.prompt([],()=>{})
      assert.equal(updates.at(-1).availability,'ready')
    }
    try { await session.prompt([],()=>{}) } catch (error) { assert.match(error.message,/connection lost|closed/i) }
    let timer
    try { await Promise.race([unknown,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('No availability invalidation after EOF')),5000)})]) } finally { clearTimeout(timer) }
    assert.equal(child.exitCode,null)
    assert.equal(child.signalCode,null)
    assert.deepEqual(updates.at(-1),{rootSessionId:'root',epoch:beforeEpoch ? null : 'e8b00b0c-1f7c-40ce-80c8-b3f7d3313720',availability:'unknown'})
    await assert.rejects(session.stopTask('task'),/connection.*closed|connection lost/i)
    const count = updates.length
    session.close(); session.close()
    await closed
    assert.equal(updates.length,count)
    assert.equal(updates.filter(value=>value.availability === 'unknown').length,1)
  } finally {
    session?.close()
    if (child && closed) await closed
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:200})
  }
})
