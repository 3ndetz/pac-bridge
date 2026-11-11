import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNativeTaskOutput } from '../src/native-task-output.mjs'

test('routes subagent output to its own registered task and waits for completion', async () => {
  const ledger = createNativeTaskOutput({ maxChars: 8 })
  const child = { sessionId: 'child' }
  const session = { nativeSubagentsByTaskId: new Map([['task', child]]) }
  ledger.capture('root', session, { sessionId: 'other', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'private' } } })
  ledger.capture('root', session, { sessionId: 'child', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } } })
  const pending = ledger.get({ rootSessionId: 'root', session, taskId: 'task', timeoutMs: 1000 })
  setTimeout(() => { ledger.capture('root', session, { sessionId: 'child', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' world' } } }); child.terminalState = 'completed' }, 10)
  assert.deepEqual(await pending, { taskId: 'task', status: 'completed', output: 'hello wo', truncated: true, outputAvailable: true })
  session.nativeSubagentsByTaskId.set('task', { sessionId: 'resumed', terminalState: 'completed' })
  assert.equal((await ledger.get({ rootSessionId: 'root', session, taskId: 'task' })).outputAvailable, false)
  await assert.rejects(ledger.get({ rootSessionId: 'another', session: { nativeSubagentsByTaskId: new Map() }, taskId: 'task' }), /Unknown/)
})

test('supports nonblocking output and cancellation', async () => {
  const ledger = createNativeTaskOutput()
  const session = { nativeSubagentsByTaskId: new Map([['task', { sessionId: 'child' }]]) }
  assert.equal((await ledger.get({ rootSessionId: 'root', session, taskId: 'task', block: false })).status, 'running')
  const controller = new AbortController(); controller.abort()
  await assert.rejects(ledger.get({ rootSessionId: 'root', session, taskId: 'task', signal: controller.signal }), /cancelled/)
})
