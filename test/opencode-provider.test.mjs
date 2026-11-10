import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { createOpencodeProvider } from '../src/opencode-provider.mjs'

test('routes a distinct user turn to its selected PAC and refuses replay', async () => {
  const calls = []
  const token = 'local-test-token-with-at-least-32-characters'
  const server = createOpencodeProvider({ token, cwd: '/source', router: {
    async prompt(binding, prompt, update) {
      calls.push({ binding, prompt })
      update({ method: '_auth/status_update', params: { secret: 'must-not-be-forwarded' } })
      update({ method: 'session/update', params: { update: { sessionUpdate: 'usage_update' } } })
      update({ method: 'session/update', params: { update: { sessionUpdate: 'available_commands_update' } } })
      update({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'remote reply' } } } })
      return { stopReason: 'end_turn' }
    }, async cancel() {}
  } })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-pac-session-id': 'session-1', 'x-pac-message-id': 'turn-1' }
  const body = JSON.stringify({ model: 'PAC_work/sonnet', stream: true, tools: [{}], messages: [{ role: 'user', content: 'hello' }] })
  try {
    const unauthorized = await fetch(url, { method: 'POST', headers: { ...headers, authorization: 'Bearer wrong' }, body })
    assert.equal(unauthorized.status, 401)
    const auxiliary = await fetch(url, { method: 'POST', headers: { authorization: headers.authorization, 'content-type': headers['content-type'] }, body })
    assert.equal(auxiliary.status, 400)
    const response = await fetch(url, { method: 'POST', headers, body })
    assert.equal(response.status, 200)
    const stream = await response.text()
    assert.match(stream, /remote reply/)
    assert.match(stream, /usage metrics are not yet displayed/)
    assert.match(stream, /remote slash commands are not yet available/)
    assert.doesNotMatch(stream, /must-not-be-forwarded/)
    assert.match(stream, /\[DONE\]/)
    assert.deepEqual(calls, [{ binding: { sessionId: 'session-1', model: 'PAC_work/sonnet', cwd: '/source' }, prompt: [{ type: 'text', text: 'hello' }] }])
    const replay = await fetch(url, { method: 'POST', headers, body })
    assert.equal(replay.status, 400)
    assert.equal(calls.length, 1)
  } finally { await new Promise((resolve) => server.close(resolve)) }
})

test('does not report an unsupported ACP event as a completed response', async () => {
  const token = 'local-test-token-with-at-least-32-characters'
  const server = createOpencodeProvider({ token, cwd: '/source', router: {
    async prompt(_binding, _prompt, update) {
      update({ method: 'session/update', params: { update: { sessionUpdate: 'tool_call' } } })
      return { stopReason: 'end_turn' }
    }, async cancel() {}
  } })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    await assert.rejects(async () => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-pac-session-id': 's', 'x-pac-message-id': 'm' },
        body: JSON.stringify({ model: 'PAC_work/sonnet', stream: true, tools: [{}], messages: [{ role: 'user', content: 'hello' }] }) })
      await response.text()
    })
  } finally { await new Promise((resolve) => server.close(resolve)) }
})
