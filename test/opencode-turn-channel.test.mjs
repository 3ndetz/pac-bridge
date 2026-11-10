import assert from 'node:assert/strict'
import test from 'node:test'
import { createOpencodeTurnChannel } from '../src/opencode-turn-channel.mjs'

test('keeps a remote turn alive across a permission response segment', async () => {
  const channel = createOpencodeTurnChannel({ sessionId: 's' })
  channel.start(async (update) => {
    update({ text: 'before' })
    const answer = await channel.requestPermission({ toolCall: { title: 'Write' }, options: [
      { optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }
    ] })
    update({ answer })
    return { stopReason: 'end_turn' }
  })
  assert.deepEqual(await channel.next(), { type: 'update', event: { text: 'before' } })
  const permission = await channel.next()
  assert.equal(permission.type, 'permission')
  assert.throws(() => channel.resolvePermission(permission.id, 'other', 'allow'), /invalid/)
  channel.resolvePermission(permission.id, 's', 'allow')
  assert.deepEqual(await channel.next(), { type: 'update', event: { answer: { outcome: { outcome: 'selected', optionId: 'allow' } } } })
  assert.deepEqual(await channel.next(), { type: 'done', result: { stopReason: 'end_turn' } })
  channel.close()
})

test('closing a turn cancels pending permissions and wakes waiting consumers', async () => {
  const channel = createOpencodeTurnChannel({ sessionId: 's' })
  let outcome
  channel.start(async () => { outcome = await channel.requestPermission({ options: [{ optionId: 'a', kind: 'allow_once' }] }) })
  const permission = await channel.next()
  const waiter = channel.next()
  channel.close()
  assert.equal((await waiter).type, 'error')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(outcome, { outcome: { outcome: 'cancelled' } })
  assert.throws(() => channel.resolvePermission(permission.id, 's', 'a'), /invalid/)
})
