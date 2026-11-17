import assert from 'node:assert/strict'
import test from 'node:test'
import { openOpencodeAcpSession } from '../src/opencode-acp-session.mjs'

const options = { command: process.execPath, args: ['-e', 'process.stdin.resume()'], cwd: process.cwd(), model: 'PAC_synthetic/sonnet', onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) }

test('a pre-cancelled ACP open never launches its invalid executable', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(openOpencodeAcpSession({ ...options, command: 'synthetic-nonexistent-executable', signal: controller.signal }), /cancelled before it started/)
})

test('cancelling a stalled ACP initialize rejects promptly without retry', { timeout: 15000 }, async () => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 100)
  try {
    await assert.rejects(openOpencodeAcpSession({ ...options, signal: controller.signal }), /closed|connection lost/)
  } finally { clearTimeout(timer); controller.abort() }
})
