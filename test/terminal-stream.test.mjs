import assert from 'node:assert/strict'
import test from 'node:test'
import { startTerminalOutputPump } from '../src/terminal-stream.mjs'

test('streams changed output without overlapping polls and stops cleanly', async () => {
  const outputs = []
  let value = ''
  let active = 0
  let maximum = 0
  const pump = startTerminalOutputPump({ intervalMs: 25, read: async () => {
    active++
    maximum = Math.max(maximum, active)
    await new Promise((resolve) => setTimeout(resolve, 30))
    active--
    return { output: value, truncated: false }
  }, emit: async (result) => outputs.push(result.output) })
  value = 'first'
  await new Promise((resolve) => setTimeout(resolve, 100))
  value = 'first second'
  await new Promise((resolve) => setTimeout(resolve, 100))
  await pump.stop()
  assert.deepEqual(outputs, ['first', 'first second'])
  assert.equal(maximum, 1)
  const count = outputs.length
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(outputs.length, count)
})

test('reports streaming failures rather than hiding them', async () => {
  const pump = startTerminalOutputPump({ intervalMs: 25, read: async () => { throw new Error('stream failed') }, emit: async () => {} })
  await new Promise((resolve) => setTimeout(resolve, 40))
  await assert.rejects(pump.stop(), /stream failed/)
})

test('bounds progress snapshots without splitting UTF-8 characters', async () => {
  const outputs = []
  const pump = startTerminalOutputPump({ intervalMs: 25, maxProgressBytes: 5,
    read: async () => ({ output: 'абвг', truncated: false }), emit: async (result) => outputs.push(result) })
  await new Promise((resolve) => setTimeout(resolve, 50))
  await pump.stop()
  assert.deepEqual(outputs, [{ output: 'вг', truncated: true }])
})
