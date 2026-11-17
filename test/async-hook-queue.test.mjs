import test from 'node:test'
import assert from 'node:assert/strict'
import { createAsyncProjectHooks } from '../src/async-project-hooks.mjs'

test('async hook output queue fails closed on overflow', async () => {
  const manager = createAsyncProjectHooks({ maxQueuedBytes: 4 })
  try {
    assert.throws(() => manager.ensureCapacity(33), /capacity/)
    manager.submit(() => Promise.resolve({ systemMessage: 'synthetic' }))
    await new Promise(resolve => setImmediate(resolve))
    assert.throws(() => manager.drain(), /capacity exceeded/)
  } finally { manager.close() }
})


test('async shutdown waits for owner cleanup and retains unconfirmed ownership failures', async () => {
  const manager = createAsyncProjectHooks()
  let reject, stopped = 0
  manager.submit(register => { register(() => { stopped++ }); return new Promise((resolve, no) => { reject = no }) })
  const closing = manager.close()
  let complete = false; closing.then(() => { complete = true }, () => {})
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(complete, false)
  assert.equal(stopped, 1)
  reject(Object.assign(new Error('synthetic missing ownership proof'), { code: 'PAC_PROCESS_EXIT_UNCONFIRMED' }))
  await assert.rejects(closing, /cleanup is unconfirmed/)
  assert.equal(manager.hasPending(), true)
  assert.throws(() => manager.drain(), /cleanup is unconfirmed/)
  await assert.rejects(manager.close(), /cleanup is unconfirmed/)
  assert.equal(stopped, 2)
})

test('async shutdown completes only after successfully drained hook work finishes', async () => {
  const manager = createAsyncProjectHooks()
  let resolve
  manager.submit(() => new Promise(yes => { resolve = yes }))
  const closed = manager.close()
  resolve({ systemMessage: 'not delivered after shutdown' })
  await closed
  assert.equal(manager.hasPending(), false)
  assert.deepEqual(manager.drain(), [])
})
