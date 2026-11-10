import assert from 'node:assert/strict'
import test from 'node:test'
import { createPermissionBroker } from '../src/opencode-permissions.mjs'

const options = [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }]

test('resolves only the permission owned by the matching session', async () => {
  const broker = createPermissionBroker()
  const a = broker.request({ sessionId: 'a', options })
  const b = broker.request({ sessionId: 'b', options })
  assert.throws(() => broker.resolve({ id: a.id, sessionId: 'b', optionId: 'allow' }), /invalid/)
  assert.throws(() => broker.resolve({ id: a.id, sessionId: 'a', optionId: 'other' }), /invalid/)
  broker.resolve({ id: b.id, sessionId: 'b', optionId: 'deny' })
  broker.resolve({ id: a.id, sessionId: 'a', optionId: 'allow' })
  assert.deepEqual(await a.result, { outcome: { outcome: 'selected', optionId: 'allow' } })
  assert.deepEqual(await b.result, { outcome: { outcome: 'selected', optionId: 'deny' } })
  assert.throws(() => broker.resolve({ id: a.id, sessionId: 'a', optionId: 'allow' }), /invalid/)
  broker.close()
})

test('cancels pending approvals and rejects late replies', async () => {
  const broker = createPermissionBroker({ limit: 1 })
  const controller = new AbortController()
  const request = broker.request({ sessionId: 'a', options, signal: controller.signal })
  assert.throws(() => broker.request({ sessionId: 'b', options }), /Too many/)
  controller.abort()
  assert.deepEqual(await request.result, { outcome: { outcome: 'cancelled' } })
  assert.throws(() => broker.resolve({ id: request.id, sessionId: 'a', optionId: 'allow' }), /invalid/)
  const second = broker.request({ sessionId: 'b', options })
  broker.close()
  assert.deepEqual(await second.result, { outcome: { outcome: 'cancelled' } })
  assert.throws(() => broker.request({ sessionId: 'a', options }), /Invalid/)
})
