import test from 'node:test'
import assert from 'node:assert/strict'
import { createSourceMcpPermission } from '../src/source-mcp-permission.mjs'
const operationId = '00000000-0000-4000-8000-000000000000'

test('permission uses an owning session and once-only options', async () => {
  const calls = []
  const request = createSourceMcpPermission({ sourceSessionId: 'source-a', client: { call: async (...args) => { calls.push(args); return { outcome: { outcome: 'selected', optionId: 'allow' } } }, notify() {} } })
  assert.equal(await request({ sourceSessionId: 'source-a', kind: 'start', server: 'server', operationId }), true)
  assert.deepEqual(calls[0][1].toolCall.rawInput, { server: 'server' })
  assert.deepEqual(calls[0][1].options.map(option => option.kind), ['allow_once', 'reject_once'])
  await assert.rejects(request({ sourceSessionId: 'source-b', kind: 'start', server: 'server', operationId }), /Invalid/)
})

test('reject and cancellation deny late approval', async () => {
  let resolve
  const events = []
  const request = createSourceMcpPermission({ sourceSessionId: 'source-a', client: { call: () => new Promise(r => { resolve = r }), notify: (...args) => events.push(args) } })
  const abort = new AbortController()
  const pending = request({ sourceSessionId: 'source-a', kind: 'call', server: 'server', tool: 'tool', arguments: {}, operationId, signal: abort.signal })
  const rejected = assert.rejects(pending, /cancelled/)
  abort.abort()
  resolve({ outcome: { outcome: 'selected', optionId: 'allow' } })
  await rejected
  assert.equal(events[0][0], 'pac/permission/cancelled')
  assert.equal(events[0][1].sessionId, 'source-a')
  const deny = createSourceMcpPermission({ sourceSessionId: 'source-a', client: { call: async () => ({ outcome: { outcome: 'selected', optionId: 'deny' } }), notify() {} } })
  assert.equal(await deny({ sourceSessionId: 'source-a', kind: 'start', server: 'server', operationId }), false)
})
