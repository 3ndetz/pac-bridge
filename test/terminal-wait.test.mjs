import assert from 'node:assert/strict'
import test from 'node:test'
import { waitForTerminal } from '../src/terminal-wait.mjs'

test('returns an exit status and reports uncertain cancellation and timeout', async () => {
  assert.deepEqual(await waitForTerminal({ wait: async () => ({ exitCode: 7 }), timeoutMs: 100 }), { exitCode: 7 })
  const controller = new AbortController()
  const pending = waitForTerminal({ wait: () => new Promise(() => {}), timeoutMs: 1000, signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, /cancelled; outcome may be unknown/)
  await assert.rejects(waitForTerminal({ wait: () => new Promise(() => {}), timeoutMs: 25 }), /timed out; outcome may be unknown/)
  await assert.rejects(waitForTerminal({ wait: async () => ({}), signal: controller.signal }), /cancelled/)
})
