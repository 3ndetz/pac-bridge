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
