import assert from 'node:assert/strict'
import test from 'node:test'
import { createSubagentTranslator } from '../src/subagent-events.mjs'

test('keeps nested subagent identities and tool events isolated', () => {
  const translator = createSubagentTranslator({ localSessionId: 'local', remoteSessionId: 'remote', pacId: 'pac-one' })
  const first = translator.translate({ sessionId: 'remote', update: { sessionUpdate: 'subagent_spawned', subagentSessionId: 'child', name: 'Background', _meta: { pacBridge: { background: true } } } })
  assert.equal(first.params.childSessionId, 'pac-one:child')
  assert.deepEqual(translator.backgroundTasks(), [{ task_id: 'pac-one:child', task_type: 'agent', description: 'Background' }])
  const nested = translator.translate({ sessionId: 'child', update: { sessionUpdate: 'subagent_spawned', subagentSessionId: 'nested' } })
  assert.equal(nested.params.parentSessionId, 'pac-one:child')
  assert.equal(nested.params.depth, 2)
  assert.equal(translator.remoteChildId('pac-one:nested'), 'nested')
  assert.throws(() => translator.remoteChildId('other-pac:nested'), /Unknown/)
  const otherSession = createSubagentTranslator({ localSessionId: 'other-local', remoteSessionId: 'other-remote', pacId: 'pac-one' })
  assert.throws(() => otherSession.remoteChildId('pac-one:nested'), /Unknown/)
  const call = translator.translate({ sessionId: 'nested', update: { sessionUpdate: 'tool_call', toolCallId: 'same-id', title: 'Read' } })
  assert.equal(call.params.update.toolCallId, 'pac-one:nested:same-id')
  assert.equal(translator.toolCallId('remote', 'same-id'), 'same-id')
  assert.equal(translator.toolCallId('nested', 'same-id'), call.params.update.toolCallId)
  assert.equal(call.params.rootSessionId, 'local')
  const finished = translator.translate({ sessionId: 'child', update: { sessionUpdate: 'subagent_state_update', subagentSessionId: 'nested', state: 'cancelled' } })
  assert.equal(finished.params.status, 'interrupted')
  assert.throws(() => translator.remoteChildId('pac-one:nested'), /inactive/)
  assert.throws(() => translator.toolCallId('nested', 'same-id'), /inactive/)
  translator.translate({ sessionId: 'remote', update: { sessionUpdate: 'subagent_state_update', subagentSessionId: 'child', state: 'completed' } })
  assert.deepEqual(translator.backgroundTasks(), [])
  assert.throws(() => translator.translate({ sessionId: 'unknown', update: { sessionUpdate: 'agent_message_chunk' } }), /Unknown/)
})
