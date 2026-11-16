import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyAgentErrors, createStageTimers, confirmArchive, parseStartupTrace } from './fixtures/mcp-diagnostic.mjs'

test('auth status and arbitrary content do not produce an error category', () => {
  const messages = [{ content: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: '_auth/status_update authentication error' } } } },
    { content: { role: 'user', content: { type: 'text', text: 'authentication error' } } },
    { content: { role: 'agent', content: { type: 'codex', data: { type: 'auth/status_update', code: 'authentication' } } } }]
  assert.deepEqual(classifyAgentErrors(messages), [])
})

test('only agent and session error events and allowlisted structured codes are classified', () => {
  const message = (type, data) => ({ content: { role: 'agent', content: { type, data } } })
  assert.deepEqual(classifyAgentErrors([message('codex', { type: 'error', code: 'authentication', message: 'private' }), message('event', { type: 'error', code: 'private-value' })]), ['agent-error:authentication', 'session-error:unknown'])
})

test('stage timers mark independent milestones only once', () => {
  let time = 100; const timer = createStageTimers(() => time)
  time = 110; timer.mark('source-start'); time = 120; timer.mark('source-start-approved'); time = 130; timer.mark('controller-call'); time = 140; timer.mark('mcp-call-approved'); time = 150; timer.mark('mcp-call'); time = 160; timer.mark('source-start')
  assert.deepEqual(timer.snapshot(), { 'source-start': 10, 'source-start-approved': 20, 'controller-call': 30, 'mcp-call-approved': 40, 'mcp-call': 50 })
  time = 170; timer.mark('agent-error'); assert.equal(timer.snapshot()['agent-error'], 70)
})

test('archive requires verified API or isolated DB state even after errors', async () => {
  assert.equal(await confirmArchive('id', async (_path, method) => method === 'POST' ? {} : { session: { active: false, metadata: { lifecycleState: 'archived' } } }, () => 'unknown'), 'api')
  assert.equal(await confirmArchive('id', async () => { throw new Error('synthetic') }, () => ({ lifecycleState: 'archived', active: false })), 'database')
  await assert.rejects(confirmArchive('id', async () => { throw new Error('synthetic') }, () => 'active'), { code: 'archive_unknown' })
  await assert.rejects(confirmArchive('id', async (_path, method) => method === 'POST' ? {} : { session: { active: true, metadata: { lifecycleState: 'archived' } } }, () => 'archived'), { code: 'archive_unknown' })
  await assert.rejects(confirmArchive('id', async (_path, method) => method === 'POST' ? {} : { session: { metadata: { lifecycleState: 'archived' } } }, () => 'archived'), { code: 'archive_unknown' })
})


test('startup trace validates labels and relative timestamps without leaking arbitrary fields', () => {
  assert.deepEqual(parseStartupTrace('{"stage":"connect_timeout","elapsedMs":30000}\n'), [{ stage: 'connect_timeout', elapsedMs: 30000 }])
  for (const text of ['{"stage":"private-secret","elapsedMs":1}', '{"stage":"process_exit","elapsedMs":1,"stderr":"private-secret"}', '{"stage":"process_exit","elapsedMs":-1}']) assert.throws(() => parseStartupTrace(text), /Invalid startup trace/)
})
