import { createInterface } from 'node:readline'
const lines = createInterface({ input: process.stdin })
const epoch = 'a238e0a6-4693-4cf3-b764-505760eb6178'
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`)
const tasks = [{ task_id: 'task', task_type: 'agent', description: 'working', secret: 'private' }]
let prompts = 0
let snapshots = 0
lines.on('line', line => {
  const message = JSON.parse(line)
  if (!Object.hasOwn(message, 'id')) return
  const reply = result => send({ jsonrpc: '2.0', id: message.id, result })
  const notify = availability => send({ jsonrpc: '2.0', method: 'pac/background_availability', params: { rootSessionId: 'root', epoch, availability, ...(availability === 'ready' ? { tasks } : {}) } })
  if (message.method === 'initialize') return reply({ protocolVersion: 1 })
  if (message.method === 'session/new') return reply({ sessionId: 'root', configOptions: [{ id: 'model', category: 'model', options: [{ value: 'PAC_test/sonnet' }] }] })
  if (message.method === 'session/set_config_option') return reply({ configOptions: [{ id: 'model', currentValue: message.params.value }] })
  if (message.method === 'session/prompt') { prompts++; notify('ready'); return reply({ stopReason: 'end_turn' }) }
  if (message.method === 'pac/background_tasks/snapshot') {
    snapshots++
    if (process.env.PAC_TEST_SNAPSHOT_RACE === '1') notify('unknown')
    return reply({ rootSessionId: process.env.PAC_TEST_BAD_SNAPSHOT === '1' || (process.env.PAC_TEST_BAD_SECOND_SNAPSHOT === '1' && snapshots > 1) ? 'other' : 'root', epoch, availability: 'ready', tasks })
  }
})
