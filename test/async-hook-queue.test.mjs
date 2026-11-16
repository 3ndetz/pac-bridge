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
