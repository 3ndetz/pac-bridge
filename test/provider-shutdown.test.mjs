import assert from 'node:assert/strict'
import { once } from 'node:events'
import { connect } from 'node:net'
import test from 'node:test'
import { createOpencodeProvider } from '../src/opencode-provider.mjs'

const token = 'synthetic-provider-shutdown-token-at-least-32'

test('closing the provider cancels an active stream before waiting for HTTP connections', { timeout: 5000 }, async () => {
  let signal, started
  const ready = new Promise(resolve => { started = resolve })
  const server = createOpencodeProvider({ token, cwd: '/synthetic', router: {
    async prompt(_binding, _prompt, update, options) {
      signal = options.signal
      update({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'started' } } } })
      started()
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
      return { stopReason: 'cancelled' }
    },
  } })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const controller = new AbortController()
  let response
  try {
    const pending = fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
      method: 'POST', signal: controller.signal,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-pac-session-id': 'session', 'x-pac-message-id': 'message' },
      body: JSON.stringify({ model: 'PAC_synthetic/sonnet', stream: true, tools: [{}], messages: [{ role: 'user', content: 'hello' }] }),
    })
    pending.catch(() => {})
    await ready
    response = await pending
    const closed = new Promise(resolve => server.close(resolve))
    assert.equal(signal.aborted, true, 'close must cancel before its HTTP callback can run')
    await closed
  } finally {
    controller.abort()
    await response?.body?.cancel().catch(() => {})
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

test('concurrent compaction requests cannot compact the same remote session twice', { timeout: 5000 }, async () => {
  let calls = 0, release, started
  const ready = new Promise(resolve => { started = resolve })
  const blocked = new Promise(resolve => { release = resolve })
  const server = createOpencodeProvider({ token, cwd: '/synthetic', router: {
    async prompt() {},
    async compact() { calls++; started(); await blocked; return { summary: 'retained' } },
  } })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const post = () => fetch(`http://127.0.0.1:${server.address().port}/pac/compact`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'session' }),
  })
  let first, second
  try {
    first = post()
    await ready
    second = post()
    const response = await Promise.race([second, new Promise(resolve => setTimeout(() => resolve(null), 2000))])
    assert.ok(response, 'duplicate compaction should be rejected while the first is pending')
    assert.equal(response.status, 409)
    assert.equal(calls, 1)
    release()
    assert.equal((await first).status, 200)
  } finally {
    release()
    await Promise.allSettled([first, second])
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})


test('shutdown closes an unfinished authenticated HTTP body', { timeout: 5000 }, async () => {
  const server = createOpencodeProvider({ token, cwd: '/synthetic', router: { async prompt() { assert.fail('incomplete body must not start a turn') } } })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const socket = connect(server.address().port, '127.0.0.1')
  socket.on('error', () => {})
  try {
    await once(socket, 'connect')
    socket.write(`POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${token}\r\nContent-Length: 1000\r\n\r\n{`)
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => server.close(resolve))
  } finally { socket.destroy(); server.closeAllConnections() }
})

test('shutdown cancels a permission between HTTP response segments', { timeout: 5000 }, async () => {
  let outcome, signal, server
  server = createOpencodeProvider({ token, cwd: '/synthetic', router: {
    async prompt(binding, _prompt, _update, options) {
      signal = options.signal
      outcome = server.requestPermission(binding.sessionId, {
        toolCall: { title: 'synthetic permission' },
        options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }],
      })
      await outcome
      return { stopReason: 'cancelled' }
    },
  } })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-pac-session-id': 'session', 'x-pac-message-id': 'message' },
      body: JSON.stringify({ model: 'PAC_synthetic/sonnet', stream: true, tools: [{ function: { name: 'pac_approval' } }], messages: [{ role: 'user', content: 'hello' }] }),
    })
    assert.match(await response.text(), /pac_approval/)
    await new Promise(resolve => server.close(resolve))
    assert.equal(signal.aborted, true)
    assert.deepEqual(await outcome, { outcome: { outcome: 'cancelled' } })
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})
