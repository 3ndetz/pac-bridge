import { Duplex } from 'node:stream'
import { createAcpPeer } from '../../src/acp-peer.mjs'

const native = process.argv.includes('--native')
let selected = 'initial'
const models = [{ value: 'initial', name: 'Initial' }, { value: 'sonnet', name: 'Sonnet' }, { value: 'opus', name: 'Opus' }]
const peer = createAcpPeer(Duplex.from({ readable: process.stdin, writable: process.stdout }), {
  onRequest: async (method, params) => {
    if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: { loadSession: true } }
    if (method === 'session/new') return { sessionId: native ? 'native-session' : 'remote-session', configOptions: [
      { id: 'model', category: 'model', currentValue: selected, options: models }
    ] }
    if (method === 'session/load') {
      if (params.sessionId !== (native ? 'native-session' : 'remote-session')) throw new Error('Unknown fake session')
      return { sessionId: params.sessionId, configOptions: [{ id: 'model', category: 'model', currentValue: selected, options: models }] }
    }
    if (method === 'session/set_config_option') {
      await new Promise((resolve) => setTimeout(resolve, params.value === 'sonnet' ? 100 : 1))
      selected = params.value
      return { configOptions: [{ id: 'model', category: 'model', currentValue: selected, options: models }] }
    }
    if (method === 'session/prompt') return { selected }
    throw new Error('Unsupported fake request')
  },
})
process.stdin.on('end', () => peer.close())
