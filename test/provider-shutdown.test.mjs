import assert from 'node:assert/strict'
import { once } from 'node:events'
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
