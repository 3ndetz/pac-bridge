import assert from 'node:assert/strict'
import { Duplex, PassThrough } from 'node:stream'
import test from 'node:test'
import { createAcpPeer } from '../src/acp-peer.mjs'
import { openPacSession } from '../src/pac-session.mjs'

test('discovers and switches only models confirmed by the named runtime session', { timeout: 3000 }, async () => {
  const first = new PassThrough()
  const second = new PassThrough()
  first.on('error', () => {})
  second.on('error', () => {})
  const client = Duplex.from({ readable: first, writable: second })
  const agentStream = Duplex.from({ readable: second, writable: first })
  const options = [{ value: 'sonnet', name: 'Sonnet' }, { value: 'opus', name: 'Opus' }]
  let receiveCancellation
  const cancellation = new Promise((resolve) => { receiveCancellation = resolve })
  const agent = createAcpPeer(agentStream, { onRequest: async (method, params) => {
    if (method === 'initialize') return { protocolVersion: 1 }
    if (method === 'session/new') return { sessionId: 'remote-session', configOptions: [{ id: 'model', category: 'model', currentValue: 'sonnet', options }] }
    if (method === 'session/set_config_option') return { configOptions: [{ id: 'model', category: 'model', currentValue: params.value, options }] }
    if (method === 'session/prompt') return { receivedSession: params.sessionId }
    throw new Error('Unexpected method')
  }, onNotification: (method, params) => {
    if (method === 'session/cancel') receiveCancellation(params)
  } })
  let session
  try {
    session = await openPacSession(client, { cwd: '/workspace' })
    assert.deepEqual(session.models, { current: 'sonnet', models: [{ id: 'sonnet', name: 'Sonnet' }, { id: 'opus', name: 'Opus' }] })
    assert.equal((await session.selectModel('opus')).current, 'opus')
    await assert.rejects(session.selectModel('unavailable'), /unavailable/)
    assert.deepEqual(await session.call('session/prompt', { sessionId: 'forged' }), { receivedSession: 'remote-session' })
    session.notify('session/cancel', { sessionId: 'forged' })
    assert.deepEqual(await cancellation, { sessionId: 'remote-session' })
  } finally { session?.close(); agent.close() }
})

test('loads the exact remote session without falling back to a new one', { timeout: 3000 }, async () => {
  const first = new PassThrough()
  const second = new PassThrough()
  first.on('error', () => {})
  second.on('error', () => {})
  const client = Duplex.from({ readable: first, writable: second })
  const agentStream = Duplex.from({ readable: second, writable: first })
  const calls = []
  const agent = createAcpPeer(agentStream, { onRequest: async (method, params) => {
    calls.push(method)
    if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: { loadSession: true } }
    if (method === 'session/load') {
      assert.equal(params.sessionId, 'remote-original')
      return { configOptions: [{ id: 'model', category: 'model', currentValue: 'sonnet', options: [{ value: 'sonnet', name: 'Sonnet' }] }] }
    }
    throw new Error('Unexpected request')
  } })
  let session
  try {
    session = await openPacSession(client, { cwd: '/workspace', resumeSessionId: 'remote-original' })
    assert.equal(session.sessionId, 'remote-original')
    assert.equal(session.models.current, 'sonnet')
    assert.deepEqual(calls, ['initialize', 'session/load'])
  } finally { session?.close(); agent.close() }
})

test('rejects a changed or unsupported resume identity without creating a session', { timeout: 3000 }, async () => {
  for (const supportsLoad of [true, false]) {
    const first = new PassThrough()
    const second = new PassThrough()
    first.on('error', () => {})
    second.on('error', () => {})
    const client = Duplex.from({ readable: first, writable: second })
    const calls = []
    const agent = createAcpPeer(Duplex.from({ readable: second, writable: first }), { onRequest: async (method) => {
      calls.push(method)
      if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: { loadSession: supportsLoad } }
      if (method === 'session/load') return { sessionId: 'different-session' }
      throw new Error('Unexpected request')
    } })
    try {
      await assert.rejects(openPacSession(client, { cwd: '/workspace', resumeSessionId: 'original' }), supportsLoad ? /different session/ : /cannot load/)
      assert.ok(!calls.includes('session/new'))
    } finally { agent.close() }
  }
})
