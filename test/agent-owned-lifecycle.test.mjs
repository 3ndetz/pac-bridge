import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { createServer } from 'node:http'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { attachAcpRelay } from '../src/acp-relay.mjs'
import { startAgent, connectSource } from '../src/acp-transport.mjs'

function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function child() { return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() }) }
async function fixture(stopChild, { onError = () => {}, maxSessions = 1 } = {}) {
  const server = createServer()
  const relay = attachAcpRelay(server, { authorize: () => true, openTimeoutMs: 150 })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const url = `ws://127.0.0.1:${server.address().port}`
  const children = [], spawned = new EventEmitter()
  const agent = await startAgent({ url, name: 'synthetic', token: 'synthetic', command: 'synthetic-no-executable', maxSessions,
    spawnChild() { const c = child(); children.push(c); spawned.emit('child', c); return c }, stopChild, onError })
  const source = async () => {
    const stream = await connectSource({ url, name: 'synthetic', token: 'synthetic' })
    stream.on('error', () => {})
    return stream
  }
  return { agent, children, spawned, source, close() { for (const c of children) c.emit('close', 0); agent.close(); relay.close(); server.close() } }
}

test('disconnected child retains its session capacity until its close is confirmed', { timeout: 5000 }, async () => {
  const stopped = deferred()
  const f = await fixture(() => stopped.resolve())
  const streams = []
  try {
    const firstSpawn = once(f.spawned, 'child')
    const first = await f.source(); streams.push(first)
    const [owned] = await firstSpawn
    first.destroy(); await stopped.promise
    const rejected = await f.source(); streams.push(rejected)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Source admitted despite an unconfirmed owned child')), 1000)
      rejected.once('end', () => { clearTimeout(timer); resolve() })
      rejected.resume()
    })
    assert.equal(f.children.length, 1, 'unconfirmed exit must not free a child slot')
    owned.emit('close', 0)
    const nextSpawn = once(f.spawned, 'child')
    streams.push(await f.source())
    await nextSpawn
    assert.equal(f.children.length, 2)
  } finally { for (const s of streams) s.destroy(); f.close() }
})

test('a failed disconnect stop remains owned and can be retried during agent shutdown', { timeout: 5000 }, async () => {
  const stopped = deferred()
  let attempts = 0
  const f = await fixture(() => { attempts++; stopped.resolve(); throw new Error('synthetic stop refused') })
  let stream
  try {
    const spawned = once(f.spawned, 'child')
    stream = await f.source(); await spawned
    stream.destroy(); await stopped.promise
    await new Promise(resolve => setImmediate(resolve))
    const before = attempts
    f.agent.close()
    assert.ok(attempts > before, 'shutdown must retain and retry its owned child')
    const after = attempts
    f.agent.close()
    assert.ok(attempts > after, 'unresolved ownership must survive an earlier shutdown attempt')
  } finally { stream?.destroy(); f.close() }
})


test('diagnostic callback errors cannot skip cleanup of other owned children', { timeout: 5000 }, async () => {
  const attempts = new Set()
  const f = await fixture(c => { attempts.add(c); throw new Error('synthetic stop refused') }, { maxSessions: 2, onError() { throw new Error('synthetic logger failure') } })
  const streams = []
  try {
    for (let i = 0; i < 2; i++) {
      const spawned = once(f.spawned, 'child')
      streams.push(await f.source())
      await spawned
    }
    assert.doesNotThrow(() => f.agent.close())
    assert.equal(attempts.size, 2)
  } finally { for (const s of streams) s.destroy(); f.close() }
})
