import { Duplex } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { createAcpPeer } from '../../src/acp-peer.mjs'

let workspace
const peer = createAcpPeer(Duplex.from({ readable: process.stdin, writable: process.stdout }), {
  onRequest: async (method, params) => {
    if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} }
    if (method === 'session/new') {
      workspace = params._meta.pac.workspaceCwd
      return { sessionId: 'source-session', configOptions: [{ id: 'model', category: 'model', currentValue: 'sonnet', options: [{ value: 'sonnet', name: 'Sonnet' }] }] }
    }
    if (method === 'session/set_config_option') return { configOptions: [{ id: 'model', category: 'model', currentValue: params.value, options: [{ value: 'sonnet', name: 'Sonnet' }] }] }
    if (method === 'session/prompt') {
      try { await peer.call('pac/terminal/start_background', { sessionId: 'source-session', operationId: randomUUID(), command: 'bash', args: ['-c', 'exit 0'], cwd: workspace }) } catch {}
      return { stopReason: 'end_turn' }
    }
    return {}
  },
})
process.stdin.on('end', () => peer.close())
