import test from 'node:test'
import assert from 'node:assert/strict'
import { createSourceQuiescence } from '../src/pac-source-quiescence.mjs'

test('source operations exclude a snapshot lease',()=>{
 let invalidations=0
 const gate=createSourceQuiescence({onInvalidate:()=>invalidations++})
 for(const kind of ['turn','hook','permission','terminal','mcp','sdk_callback','control']) {
  const finish=gate.enter(kind)
  assert.equal(gate.activeCount,1);assert.equal(gate.acquire(),null)
  finish();finish();assert.equal(gate.activeCount,0)
 }
 const lease=gate.acquire();assert.equal(lease.valid(),true)
 for(const kind of ['turn','hook','permission','terminal','mcp','sdk_callback','control'])assert.throws(()=>gate.enter(kind),/unavailable/)
 assert.equal(gate.acquire(),null);lease.release();assert.equal(invalidations,14)
})

test('autonomous callback revokes a lease synchronously without blocking callback progress',()=>{
 const gate=createSourceQuiescence({onInvalidate:()=>{}})
 const lease=gate.acquire();assert.equal(lease.valid(),true)
 const finish=gate.enterExternal('sdk_callback')
 assert.equal(lease.valid(),false);assert.equal(gate.activeCount,1)
 lease.release();assert.equal(gate.acquire(),null)
 finish();assert.equal(gate.activeCount,0)
 assert.ok(gate.acquire())
})

test('loss invalidates the current lease and closed epochs cannot restart',()=>{
 let invalidations=0
 const gate=createSourceQuiescence({onInvalidate:()=>invalidations++})
 const lease=gate.acquire();gate.invalidate();assert.equal(lease.valid(),false)
 assert.equal(gate.acquire(),null);lease.release()
 const next=gate.acquire();assert.equal(next.valid(),true)
 gate.close();assert.equal(next.valid(),false);assert.equal(gate.acquire(),null)
 assert.throws(()=>gate.enter('turn'),/unavailable/)
 gate.close();assert.equal(invalidations,2)
})

test('delivery failure prevents entry and does not retain an operation',()=>{
 const gate=createSourceQuiescence({onInvalidate:()=>{throw new Error('delivery failed')}})
 assert.throws(()=>gate.enter('hook'),/delivery failed/)
 assert.equal(gate.activeCount,0)
 assert.equal(gate.acquire(),null)
})

test('wrapped autonomous callbacks invalidate first and stay tracked until they settle',async()=>{
 const gate=createSourceQuiescence({onInvalidate:()=>{}}),lease=gate.acquire()
 let finish,entered
 const called=new Promise(resolve=>{entered=resolve})
 const callback=gate.wrapExternal('permission',async()=>{entered();return await new Promise(resolve=>{finish=resolve})})
 const pending=callback();await called
 assert.equal(lease.valid(),false);lease.release();assert.equal(gate.acquire(),null)
 finish('denied');assert.equal(await pending,'denied');assert.equal(gate.activeCount,0)
 const failure=gate.wrapExternal('hook',async()=>{throw new Error('failed')})
 await assert.rejects(failure(),/failed/);assert.equal(gate.activeCount,0)
})
