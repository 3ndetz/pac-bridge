import assert from 'node:assert/strict'
import { Duplex, PassThrough } from 'node:stream'
import test from 'node:test'
import { createAcpPeer } from '../src/acp-peer.mjs'

function streams() {
  const first = new PassThrough()
  const second = new PassThrough()
  first.on('error', () => {})
  second.on('error', () => {})
  return [Duplex.from({ readable: first, writable: second }), Duplex.from({ readable: second, writable: first })]
}

test('supports bidirectional concurrent requests and notifications', async () => {
  const [firstStream, secondStream] = streams()
  const updates = []
  const first = createAcpPeer(firstStream, { onRequest: async (method, params) => ({ method, params }), onNotification: (method) => updates.push(method) })
  const second = createAcpPeer(secondStream, { onRequest: async (method, params) => ({ method, params }) })
  try {
    const results = await Promise.all([first.call('session/new', { cwd: 'one' }), second.call('fs/read_text_file', { path: 'two' })])
    assert.deepEqual(results, [{ method: 'session/new', params: { cwd: 'one' } }, { method: 'fs/read_text_file', params: { path: 'two' } }])
    second.notify('session/update', {})
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(updates, ['session/update'])
  } finally { first.close(); second.close() }
})

test('reports unknown outcome on timeout or disconnect, without retrying', async () => {
  const [firstStream, secondStream] = streams()
  let calls = 0
  const first = createAcpPeer(firstStream)
  const second = createAcpPeer(secondStream, { onRequest: () => { calls++; return new Promise(() => {}) } })
  try {
    await assert.rejects(first.call('side-effect', {}, 20), /outcome may be unknown/)
    assert.equal(calls, 1)
    const result = first.call('another-side-effect', {}, 1000)
    await new Promise((resolve) => setImmediate(resolve))
    second.close()
    await assert.rejects(result, /outcome may be unknown/)
    assert.equal(calls, 2)
  } finally { first.close(); second.close() }
})

test('preserves notification order when a handler is asynchronous', async () => {
  const [firstStream, secondStream] = streams()
  const seen = []
  let release
  const blocked = new Promise((resolve) => { release = resolve })
  const first = createAcpPeer(firstStream, { onNotification: async (method) => { if (method === 'first') await blocked; seen.push(method) } })
  const second = createAcpPeer(secondStream)
  try {
    second.notify('first', {})
    second.notify('second', {})
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(seen, [])
    release()
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(seen, ['first', 'second'])
  } finally { first.close(); second.close() }
})

test('bounds queued notifications and reports an uncertain in-flight call', async () => {
  const [firstStream, secondStream] = streams()
  let release
  const blocked = new Promise((resolve) => { release = resolve })
  const first = createAcpPeer(firstStream, { maxQueuedNotificationBytes: 160, onNotification: () => blocked })
  const second = createAcpPeer(secondStream, { onRequest: () => new Promise(() => {}) })
  try {
    const pending = first.call('side-effect', {}, 1000)
    second.notify('update', { text: 'x'.repeat(50) })
    second.notify('update', { text: 'x'.repeat(50) })
    await assert.rejects(pending, /outcome may be unknown/)
    await assert.rejects(first.call('later', {}), /closed/)
  } finally { release(); first.close(); second.close() }
})

test('bounds in-flight request data without dispatching requests over the limit', async () => {
  const [firstStream, secondStream] = streams()
  let calls = 0
  let release
  const blocked = new Promise((resolve) => { release = resolve })
  const first = createAcpPeer(firstStream, { maxInFlightRequestBytes: 220, onRequest: () => { calls++; return blocked } })
  const second = createAcpPeer(secondStream)
  try {
    const firstCall = second.call('write', { text: 'x'.repeat(50) }, 1000)
    const secondCall = second.call('write', { text: 'x'.repeat(50) }, 1000)
    const outcomes = await Promise.allSettled([firstCall, secondCall])
    assert.ok(outcomes.every((result) => result.status === 'rejected' && /outcome may be unknown/.test(result.reason.message)))
    assert.equal(calls, 1)
  } finally { release(); first.close(); second.close() }
})

test('closes an oversized unfinished message and reports an uncertain in-flight call', async () => {
  const [firstStream, secondStream] = streams()
  secondStream.on('error', () => {})
  const first = createAcpPeer(firstStream, { maxLineBytes: 128 })
  try {
    const pending = first.call('side-effect', {}, 1000)
    secondStream.write('x'.repeat(129))
    await assert.rejects(pending, /outcome may be unknown/)
  } finally { first.close(); secondStream.destroy() }
})

test('does not dispatch messages after an oversized line in the same chunk', async () => {
  const [firstStream, secondStream] = streams()
  secondStream.on('error', () => {})
  const calls = []
  const first = createAcpPeer(firstStream, { maxLineBytes: 128, onRequest: (method) => calls.push(method) })
  try {
    secondStream.write(`${'x'.repeat(129)}\n${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'side-effect' })}\n`)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(calls, [])
  } finally { first.close(); secondStream.destroy() }
})

test('accepts fragmented UTF-8 messages and multiple short lines within the limit', async () => {
  const [firstStream, secondStream] = streams()
  secondStream.on('error', () => {})
  const seen = []
  const first = createAcpPeer(firstStream, { maxLineBytes: 128, onNotification: (_method, params) => seen.push(params.text) })
  try {
    const line = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'update', params: { text: 'привет' } }) + '\n')
    const split = line.indexOf(Buffer.from('пр')) + 1
    secondStream.write(line.subarray(0, split))
    secondStream.write(Buffer.concat([line.subarray(split), line, line]))
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(seen, ['привет', 'привет', 'привет'])
  } finally { first.close(); secondStream.destroy() }
})
