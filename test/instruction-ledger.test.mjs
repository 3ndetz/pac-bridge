import assert from 'node:assert/strict'
import test from 'node:test'
import { createInstructionLedger } from '../src/instruction-ledger.mjs'

test('tracks main and subagent instructions independently and bounds state', () => {
  const ledger = createInstructionLedger({ maxOwners: 3, maxPathsPerOwner: 2 })
  const entries = [{ path: '/one' }, { path: '/two' }]
  ledger.mark(undefined, [entries[0]])
  assert.deepEqual(ledger.unseen(undefined, entries), [entries[1]])
  assert.deepEqual(ledger.unseen('child', entries), entries)
  ledger.mark('child', entries)
  assert.deepEqual(ledger.unseen('child', entries), [])
  assert.deepEqual(ledger.unseen('other', entries), entries)
  assert.throws(() => ledger.unseen('fourth', entries), /owner limit/)
  assert.throws(() => ledger.mark('child', [{ path: '/three' }]), /path limit/)
})
