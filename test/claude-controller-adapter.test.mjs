import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { Duplex } from 'node:stream'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createAcpPeer } from '../src/acp-peer.mjs'

test('initializes the Claude controller with project dependencies without signing in', { timeout: 30000 }, async () => {
  const adapter = fileURLToPath(new URL('../adapters/pac-claude-agent.mjs', import.meta.url))
  const child = spawn(process.execPath, [adapter], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  child.stderr.resume()
  const peer = createAcpPeer(Duplex.from({ readable: child.stdout, writable: child.stdin }))
  try {
    const result = await peer.call('initialize', { protocolVersion: 1, clientCapabilities: {} })
    assert.equal(result.protocolVersion, 1)
  } finally { peer.close(); child.kill() }
})
