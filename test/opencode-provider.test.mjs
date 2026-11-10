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
      update({ method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Read', rawInput: { path: 'a.txt' }, _meta: { secret: 'must-not-be-forwarded' } } } })
      update({ method: 'opencode/session/child_update', params: { childSessionId: 'pac:child', parentSessionId: 'session-1', depth: 1, type: 'status', status: 'created', secret: 'must-not-be-forwarded' } })
      update({ method: 'pac/background_tasks_changed', params: { tasks: [{ task_id: 'pac:child', task_type: 'agent', description: 'Test child', secret: 'must-not-be-forwarded' }] } })
      update({ method: 'session/update', params: { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'synthetic thought' } } } })
      update({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'remote ' } } } })
      update({ method: 'session/update', params: { update: { sessionUpdate: 'usage_update' } } })
      update({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'reply' } } } })
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
    const resumed = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ model: 'PAC_work/sonnet', stream: true, tools: [{}],
      messages: [{ role: 'user', content: 'previous' }, { role: 'assistant', content: 'previous answer' }, { role: 'user', content: 'continue' }] }) })
    assert.equal(resumed.status, 400)
    assert.match(await resumed.text(), /binding is unavailable/)
    const response = await fetch(url, { method: 'POST', headers, body })
    assert.equal(response.status, 200)
    const stream = await response.text()
    const content = stream.split('\n').filter((line) => line.startsWith('data: {')).map((line) => JSON.parse(line.slice(6))).map((item) => item.choices[0].delta.content || '').join('')
    assert.match(content, /remote reply/)
    assert.equal((content.match(/usage metrics are not yet displayed/g) || []).length, 1)
    assert.match(stream, /"reasoning_content":"synthetic thought"/)
    assert.match(stream, /usage metrics are not yet displayed/)
    assert.match(stream, /remote slash commands are not yet available/)
    assert.match(stream, /call-1/)
    assert.match(stream, /PAC subagent event/)
    assert.match(stream, /PAC background tasks/)
    assert.match(stream, /pac:child/)
    assert.doesNotMatch(stream, /must-not-be-forwarded/)
    assert.match(stream, /\[DONE\]/)
    assert.deepEqual(calls, [{ binding: { sessionId: 'session-1', model: 'PAC_work/sonnet', cwd: '/source' }, prompt: [{ type: 'text', text: 'hello' }] }])
    const replay = await fetch(url, { method: 'POST', headers, body })
    assert.equal(replay.status, 400)
    assert.equal(calls.length, 1)
  } finally { await new Promise((resolve) => server.close(resolve)) }
})

test('forwards inline images and rejects remote or malformed attachments', async () => {
  const token = 'local-test-token-with-at-least-32-characters'
  let received
  const server = createOpencodeProvider({ token, cwd: '/source', router: {
    async prompt(_binding, prompt) { received = prompt; return { stopReason: 'end_turn' } },
  } })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-pac-session-id': 's', 'x-pac-message-id': 'm' }
  const post = (content) => fetch(url, { method: 'POST', headers, body: JSON.stringify({ model: 'PAC_work/sonnet', stream: true, tools: [{}], messages: [{ role: 'user', content }] }) })
  try {
    assert.equal((await post([{ type: 'image_url', image_url: { url: 'https://example.test/image.png' } }])).status, 400)
    assert.equal((await post([{ type: 'image_url', image_url: { url: 'data:image/png;base64,%%%%' } }])).status, 400)
    const response = await post([{ type: 'text', text: 'Describe' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } }])
    assert.match(await response.text(), /\[DONE\]/)
    assert.deepEqual(received, [{ type: 'text', text: 'Describe' }, { type: 'image', mimeType: 'image/png', data: 'AQID' }])
  } finally { await new Promise((resolve) => server.close(resolve)) }
})

test('does not report an unsupported ACP event as a completed response', async () => {
  const token = 'local-test-token-with-at-least-32-characters'
  const server = createOpencodeProvider({ token, cwd: '/source', router: {
    async prompt(_binding, _prompt, update) {
      update({ method: 'session/update', params: { update: { sessionUpdate: 'subagent_spawned' } } })
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

test('keeps the same PAC turn across a session-bound approval and continuation', async () => {
  const token = 'local-test-token-with-at-least-32-characters'
  let calls = 0, server
  server = createOpencodeProvider({ token, cwd: '/source', router: {
    async prompt(binding, _prompt, update) {
      calls++
      const decision = await server.requestPermission(binding.sessionId, { toolCall: { title: 'Write test file' }, options: [
        { optionId: 'allow-id', kind: 'allow_once' }, { optionId: 'deny-id', kind: 'reject_once' }
      ] })
      assert.deepEqual(decision, { outcome: { outcome: 'selected', optionId: 'allow-id' } })
      update({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'completed once' } } } })
      return { stopReason: 'end_turn' }
    }, async cancel() {}
  } })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-pac-session-id': 's', 'x-pac-message-id': 'm' }
  const tools = [{ type: 'function', function: { name: 'pac_approval' } }]
  const post = (url, body) => fetch(base + url, { method: 'POST', headers, body: JSON.stringify(body) })
  try {
    const initial = await post('/v1/chat/completions', { model: 'PAC_work/sonnet', stream: true, tools, messages: [{ role: 'user', content: 'write' }] })
    const text = await initial.text()
    const toolEvent = text.split('\n').filter((line) => line.startsWith('data: {')).map((line) => JSON.parse(line.slice(6))).find((item) => item.choices[0].delta.tool_calls)
    const id = toolEvent.choices[0].delta.tool_calls[0].id
    assert.match(text, /tool_calls/)
    assert.equal((await post('/pac/approval', { action: 'inspect', id, sessionId: 'other' })).status, 400)
    assert.equal((await post('/pac/approval', { action: 'inspect', id, sessionId: 's' })).status, 200)
    assert.equal((await post('/pac/approval', { action: 'resolve', id, sessionId: 's', decision: 'allow' })).status, 200)
    assert.equal((await post('/pac/approval', { action: 'resolve', id, sessionId: 's', decision: 'allow' })).status, 400)
    const next = await post('/v1/chat/completions', { model: 'PAC_work/sonnet', stream: true, tools, messages: [{ role: 'tool', tool_call_id: id, content: 'approved' }] })
    assert.match(await next.text(), /completed once/)
    assert.equal(calls, 1)
  } finally { await new Promise((resolve) => server.close(resolve)) }
})

test('expires an abandoned approval and cancels its remote turn', async () => {
  const token = 'local-test-token-with-at-least-32-characters'
  let server, aborted = false
  server = createOpencodeProvider({ token, cwd: '/source', permissionTimeoutMs: 20, router: {
    async prompt(binding, _prompt, _update, { signal }) {
      signal.addEventListener('abort', () => { aborted = true }, { once: true })
      await server.requestPermission(binding.sessionId, { toolCall: { title: 'Write' }, options: [
        { optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }
      ] })
      return { stopReason: 'end_turn' }
    }
  } })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-pac-session-id': 's', 'x-pac-message-id': 'm' },
      body: JSON.stringify({ model: 'PAC_work/sonnet', stream: true, tools: [{ function: { name: 'pac_approval' } }], messages: [{ role: 'user', content: 'write' }] }) })
    assert.match(await response.text(), /tool_calls/)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(aborted, true)
  } finally { await new Promise((resolve) => server.close(resolve)) }
})

test('reports a controller authentication failure on a retry without replaying the turn', async () => {
  const token = 'local-test-token-with-at-least-32-characters'
  let calls = 0
  const server = createOpencodeProvider({ token, cwd: '/source', router: {
    async prompt() { calls++; throw new Error('Authentication failed with private-detail') }
  } })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-pac-session-id': 's', 'x-pac-message-id': 'm' }
  const body = JSON.stringify({ model: 'PAC_work/sonnet', stream: true, tools: [{}], messages: [{ role: 'user', content: 'hi' }] })
  try {
    try { const first = await fetch(url, { method: 'POST', headers, body }); await first.text() } catch {}
    const retry = await fetch(url, { method: 'POST', headers, body })
    assert.equal(retry.status, 400)
    const error = await retry.text()
    assert.match(error, /authentication failed on the controller/)
    assert.doesNotMatch(error, /private-detail/)
    assert.equal(calls, 1)
  } finally { await new Promise((resolve) => server.close(resolve)) }
})

test('reports an uncertain earlier turn without replaying it', async () => {
  const token = 'local-test-token-with-at-least-32-characters'
  let calls = 0
  const server = createOpencodeProvider({ token, cwd: '/source', router: {
    async canResume() { throw new Error('Previous PAC turn outcome is unknown; reconciliation is required') },
    async prompt() { calls++; return { stopReason: 'end_turn' } },
  } })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-pac-session-id': 's', 'x-pac-message-id': 'm' },
      body: JSON.stringify({ model: 'PAC_work/sonnet', stream: true, tools: [{}], messages: [{ role: 'user', content: 'before' }, { role: 'assistant', content: 'before' }, { role: 'user', content: 'continue' }] }) })
    assert.equal(response.status, 400)
    assert.match(await response.text(), /outcome is unknown; reconcile/)
    assert.equal(calls, 0)
  } finally { await new Promise((resolve) => server.close(resolve)) }
})

test('never turns an interactive question into an approval', async () => {
  const token = 'local-test-token-with-at-least-32-characters'
  let server
  server = createOpencodeProvider({ token, cwd: '/source', router: {
    async prompt(binding) {
      return server.requestPermission(binding.sessionId, { _meta: { pac: { question: true } },
        toolCall: { title: 'AskUserQuestion', rawInput: { questions: [{ question: 'Choose?' }] } },
        options: [{ optionId: 'answer', kind: 'allow_once' }, { optionId: 'cancel', kind: 'reject_once' }] })
    }
  } })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-pac-session-id': 's', 'x-pac-message-id': 'q' }
  const body = JSON.stringify({ model: 'PAC_work/sonnet', stream: true, tools: [{ function: { name: 'pac_approval' } }], messages: [{ role: 'user', content: 'hi' }] })
  try {
    let first = ''
    try { const response = await fetch(url, { method: 'POST', headers, body }); first = await response.text() } catch {}
    assert.doesNotMatch(first, /PAC approval requested/)
    const retry = await fetch(url, { method: 'POST', headers, body })
    assert.equal(retry.status, 400)
    assert.match(await retry.text(), /interactive questions are not supported/)
  } finally { await new Promise((resolve) => server.close(resolve)) }
})

test('routes native question answers only to their owning PAC turn', async () => {
  const token = 'local-test-token-with-at-least-32-characters'
  let server, received
  server = createOpencodeProvider({ token, cwd: '/source', router: {
    async prompt(binding, _prompt, update) {
      received = await server.requestPermission(binding.sessionId, { _meta: { pac: { question: true } },
        toolCall: { rawInput: { questions: [
          { question: 'Name?', header: 'Name', options: [{ label: 'A', description: 'Option A' }], multiSelect: false },
          { question: 'Colors?', header: 'Colors', options: [{ label: 'Red', description: 'Red' }, { label: 'Blue', description: 'Blue' }], multiSelect: true },
        ] } }, options: [{ optionId: 'answer', kind: 'allow_once' }, { optionId: 'cancel', kind: 'reject_once' }] })
      update({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answered' } } } })
      return { stopReason: 'end_turn' }
    }
  } })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-pac-session-id': 's', 'x-pac-message-id': 'm' }
  const tools = [{ function: { name: 'question' } }]
  const post = (url, body) => fetch(base + url, { method: 'POST', headers, body: JSON.stringify(body) })
  try {
    const response = await post('/v1/chat/completions', { model: 'PAC_work/sonnet', stream: true, tools, messages: [{ role: 'user', content: 'ask' }] })
    const events = (await response.text()).split('\n').filter((line) => line.startsWith('data: {')).map((line) => JSON.parse(line.slice(6)))
    const call = events.find((event) => event.choices[0].delta.tool_calls).choices[0].delta.tool_calls[0]
    assert.equal(call.function.name, 'question')
    assert.equal(JSON.parse(call.function.arguments).questions[1].multiple, true)
    assert.equal((await post('/pac/approval', { action: 'cancel', id: call.id, sessionId: 'other' })).status, 400)
    assert.equal((await post('/pac/approval', { action: 'resolve', id: call.id, sessionId: 'other', answers: [['Custom'], ['Red', 'Blue']] })).status, 400)
    assert.equal((await post('/pac/approval', { action: 'resolve', id: call.id, sessionId: 's', answers: [['Custom', 'A'], ['Red']] })).status, 400)
    assert.equal((await post('/pac/approval', { action: 'resolve', id: call.id, sessionId: 's', answers: [['Custom'], ['Red', 'Blue']] })).status, 200)
    const next = await post('/v1/chat/completions', { model: 'PAC_work/sonnet', stream: true, tools, messages: [{ role: 'tool', tool_call_id: call.id, content: 'answered' }] })
    assert.match(await next.text(), /answered/)
    assert.deepEqual(received, { outcome: { outcome: 'selected', optionId: 'answer' }, _meta: { pac: { answers: { 0: ['Custom'], 1: ['Red', 'Blue'] } } } })
  } finally { await new Promise((resolve) => server.close(resolve)) }
})

test('cancels a native question when OpenCode continues without an answer', async () => {
  const token = 'local-test-token-with-at-least-32-characters'
  let server, received
  server = createOpencodeProvider({ token, cwd: '/source', router: {
    async prompt(binding) {
      received = await server.requestPermission(binding.sessionId, { _meta: { pac: { question: true } },
        toolCall: { rawInput: { questions: [{ question: 'Continue?', header: 'Continue', options: [{ label: 'Yes', description: 'Yes' }] }] } },
        options: [{ optionId: 'answer', kind: 'allow_once' }, { optionId: 'cancel', kind: 'reject_once' }] })
      return { stopReason: 'end_turn' }
    }
  } })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-pac-session-id': 's', 'x-pac-message-id': 'm' }
  const tools = [{ function: { name: 'question' } }]
  const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`
  const post = (body) => fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  try {
    const response = await post({ model: 'PAC_work/sonnet', stream: true, tools, messages: [{ role: 'user', content: 'ask' }] })
    const events = (await response.text()).split('\n').filter((line) => line.startsWith('data: {')).map((line) => JSON.parse(line.slice(6)))
    const id = events.find((event) => event.choices[0].delta.tool_calls).choices[0].delta.tool_calls[0].id
    const next = await post({ model: 'PAC_work/sonnet', stream: true, tools, messages: [{ role: 'tool', tool_call_id: id, content: 'rejected' }] })
    assert.match(await next.text(), /\[DONE\]/)
    assert.deepEqual(received, { outcome: { outcome: 'selected', optionId: 'cancel' } })
  } finally { await new Promise((resolve) => server.close(resolve)) }
})
