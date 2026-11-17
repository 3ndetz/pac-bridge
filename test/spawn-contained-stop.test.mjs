import assert from 'node:assert/strict'
import test from 'node:test'
import { stopContained } from '../src/spawn-contained.mjs'

test('Windows stop requests use the owned child only once while its exit is pending', { skip: process.platform !== 'win32' }, () => {
  let calls = 0
  const child = { pid: 123, exitCode: null, signalCode: null, kill() { calls++; return calls === 1 } }
  stopContained(child)
  stopContained(child)
  assert.equal(calls, 1)
  assert.equal(child.exitCode, null, 'accepted stop does not confirm process exit')
})

test('a refused Windows stop remains explicit and may be retried by its owner', { skip: process.platform !== 'win32' }, () => {
  let calls = 0
  const child = { pid: 123, exitCode: null, signalCode: null, kill() { return ++calls > 1 } }
  assert.throws(() => stopContained(child), /outcome is unknown/)
  stopContained(child)
  stopContained(child)
  assert.equal(calls, 2)
})
