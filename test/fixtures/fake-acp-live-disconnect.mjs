import { createInterface } from 'node:readline'
import { writeFileSync } from 'node:fs'

writeFileSync(process.env.PAC_TEST_PID_FILE, String(process.pid))
process.stdout.on('error', () => {})
setInterval(() => {}, 1000)
const epoch = 'e8b00b0c-1f7c-40ce-80c8-b3f7d3313720'
const tasks = [{ task_id:'task', task_type:'agent', description:'working' }]
let prompts = 0
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
createInterface({ input:process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (!Object.hasOwn(message,'id')) return
  const reply = result => send({ jsonrpc:'2.0', id:message.id, result })
  if (message.method === 'initialize') return reply({protocolVersion:1})
  if (message.method === 'session/new') return reply({sessionId:'root',configOptions:[{id:'model',category:'model',options:[{value:'PAC_test/sonnet'}]}]})
  if (message.method === 'session/set_config_option') return reply({configOptions:[{id:'model',currentValue:message.params.value}]})
  if (message.method === 'pac/background_tasks/snapshot') return reply({rootSessionId:'root',epoch,availability:'ready',tasks})
  if (message.method === 'session/prompt') {
    prompts++
    const foreign = prompts > 1 || process.env.PAC_TEST_BEFORE_EPOCH === '1'
    send({jsonrpc:'2.0',method:'pac/background_availability',params:{rootSessionId:foreign ? 'foreign' : 'root',epoch,availability:'ready',tasks}})
    if (foreign) send({jsonrpc:'2.0',method:'pac/background_availability',params:{rootSessionId:'root',epoch,availability:'ready',tasks}})
    return reply({stopReason:'end_turn'})
  }
})
