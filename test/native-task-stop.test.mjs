import assert from 'node:assert/strict'
import test from 'node:test'
import { stopNativeTask } from '../src/native-task-stop.mjs'

test('stops only an active native task belonging to the session', async () => {
  const stopped = []
  const session = { nativeSubagentRuntime: { children: new Map([['active', { sessionId: 'child-session' }], ['finished', { terminalState: 'completed' }]]) },
    query: { stopTask: async (taskId) => { stopped.push(taskId) } } }
  assert.deepEqual(await stopNativeTask(session, 'active'), { status: 'stop_requested', taskId: 'active' })
  assert.deepEqual(await stopNativeTask(session, 'child-session'), { status: 'stop_requested', taskId: 'child-session' })
  assert.deepEqual(await stopNativeTask(session, 'finished'), { status: 'completed', taskId: 'finished' })
  await assert.rejects(stopNativeTask(session, 'other-session-task'), /Unknown/)
  session.nativeSubagentRuntime.children.set('duplicate', { sessionId: 'child-session' })
  await assert.rejects(stopNativeTask(session, 'child-session'), /Ambiguous/)
  assert.deepEqual(stopped, ['active', 'active'])
})

test('fails visibly when native task control is unavailable or rejects', async () => {
  await assert.rejects(stopNativeTask({}, 'task'), /unavailable/)
  const session = { nativeSubagentRuntime: { children: new Map([['task', {}]]) }, query: { stopTask: async () => { throw new Error('SDK rejected stop') } } }
  await assert.rejects(stopNativeTask(session, 'task'), /SDK rejected stop/)
})
