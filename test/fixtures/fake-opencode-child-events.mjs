import { createInterface } from 'node:readline'
const input = createInterface({ input: process.stdin })
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
let prompts = 0
input.on('line', (line) => {
  const message = JSON.parse(line)
  if (!Object.hasOwn(message, 'id')) return
  const reply = (result) => send({ jsonrpc: '2.0', id: message.id, result })
  if (message.method === 'initialize') return reply({ protocolVersion: 1 })
  if (message.method === 'session/new') return reply({ sessionId: 'root', configOptions: [{ id: 'model', category: 'model', currentValue: 'PAC_test/sonnet', options: [{ value: 'PAC_test/sonnet', name: 'Sonnet' }] }] })
  if (message.method === 'session/set_config_option') return reply({ configOptions: [{ id: 'model', category: 'model', currentValue: message.params.value, options: [{ value: 'PAC_test/sonnet', name: 'Sonnet' }] }] })
  if (message.method === 'session/prompt') {
    if (++prompts === 1) {
      send({ jsonrpc: '2.0', method: 'opencode/session/child_update', params: { rootSessionId: process.env.PAC_TEST_BAD_CHILD_OWNER === '1' ? 'other' : 'root', childSessionId: 'pac:child', parentSessionId: 'root', depth: 1, type: 'status', status: 'created' } })
      if (process.env.PAC_TEST_BAD_CHILD_OWNER === '1') return setTimeout(() => reply({ stopReason: 'end_turn' }), 100)
      reply({ stopReason: 'end_turn' })
      setTimeout(() => send({ jsonrpc: '2.0', method: 'opencode/session/child_update', params: { rootSessionId: 'root', childSessionId: 'pac:child', parentSessionId: 'root', depth: 1, type: 'status', status: 'completed' } }), 100)
    } else reply({ stopReason: 'end_turn' })
  }
})
