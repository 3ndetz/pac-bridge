import test from 'node:test'
import assert from 'node:assert/strict'
import { createPacSnapshotGate } from '../src/pac-snapshot-gate.mjs'

test('publishes only an authoritative snapshot after a session-bound handshake', () => {
  const events = [], gate = createPacSnapshotGate({ publish: event => events.push(event) })
  const epoch = gate.open('owner'), other = gate.open('other')
  gate.authoritative('owner', epoch, [{ task_id:'task', task_type:'agent', description:'work', private:'secret' }])
  assert.equal(events.at(-1).availability, 'unknown')
  assert.equal(Object.hasOwn(events.at(-1), 'tasks'), false)
  assert.throws(() => gate.handshake('other', epoch), /Stale/)
  gate.handshake('owner', epoch)
  assert.deepEqual(events.at(-1), { sessionId:'owner', epoch, availability:'ready', tasks:[{ task_id:'task', task_type:'agent', description:'work' }] })
  assert.throws(() => gate.update('other', other, []), /not authoritative/)
  gate.update('owner', epoch, [])
  assert.deepEqual(events.at(-1).tasks, [])
  gate.disconnect('owner', epoch)
  assert.equal(events.at(-1).availability, 'unknown')
  const next = gate.open('owner')
  assert.notEqual(next, epoch)
  gate.handshake('owner', next)
  assert.equal(events.at(-1).availability, 'unknown')
  assert.throws(() => gate.authoritative('owner', epoch, []), /Stale/)
  assert.throws(() => gate.authoritative('owner', next, [{task_id:'',task_type:'agent',description:''}]), /Invalid/)
  assert.equal(events.at(-1).availability, 'unknown')
  gate.authoritative('owner', next, [])
  assert.deepEqual(events.at(-1).tasks, [])
})


test('fails closed when delivery fails', () => {
  let fail = false
  const gate = createPacSnapshotGate({ publish: () => { if (fail) throw new Error('delivery failed') } })
  const epoch = gate.open('owner')
  gate.handshake('owner', epoch)
  fail = true
  assert.throws(() => gate.authoritative('owner', epoch, []), /delivery failed/)
  assert.throws(() => gate.update('owner', epoch, []), /Stale/)
})
