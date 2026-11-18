import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createOpencodeProvider } from '../src/opencode-provider.mjs'
import { createPacStopJournal } from '../src/pac-stop-journal.mjs'

test('publishes normalized background tasks only to their owning session', async () => {
  const token = 'local-test-token-with-at-least-32-characters'
  const received = []
  let rejectUpdate = false
  const server = createOpencodeProvider({ token, cwd: '/source', onBackgroundTasks(sessionId, tasks) {
    if (rejectUpdate) throw new Error('private callback details')
    received.push({ sessionId, tasks })
  }, router: { async prompt(binding, _prompt, update) {
    update({ method: 'pac/background_tasks_changed', params: { tasks: [{ task_id: `${binding.sessionId}-task`, task_type: 'agent', description: 'work', secret: 'private' }] } })
    return { stopReason: 'end_turn' }
  } } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`
  const post = sessionId => fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
    'x-pac-session-id': sessionId, 'x-pac-message-id': `message-${sessionId}` },
    body: JSON.stringify({ model: 'PAC_work/sonnet', stream: true, tools: [{}], messages: [{ role: 'user', content: 'hello' }] }) })
  try {
    for (const sessionId of ['first', 'second']) {
      const response = await post(sessionId)
      assert.equal(response.status, 200)
      assert.doesNotMatch(await response.text(), /private/)
    }
    assert.deepEqual(received, ['first', 'second'].map(sessionId => ({ sessionId, tasks: [{ task_id: `${sessionId}-task`, task_type: 'agent', description: 'work' }] })))
    rejectUpdate = true
    const failure = await post('third')
    assert.equal(failure.status, 400)
    assert.doesNotMatch(await failure.text(), /private callback details/)
    assert.equal(received.length, 2)
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('accepts a multi-megabyte history while forwarding only the new turn', async () => {
  const token = 'local-test-token-with-at-least-32-characters'
  let received
  const server = createOpencodeProvider({ token, cwd: '/source', router: {
    hasSession: () => true,
    async prompt(_binding, prompt) { received = prompt; return { stopReason: 'end_turn' } },
  } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  try {
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-pac-session-id': 'session', 'x-pac-message-id': 'large' }
    const body = JSON.stringify({ model: 'PAC_work/sonnet', stream: true, tools: [{}], messages: [
      { role: 'assistant', content: 'x'.repeat(2 * 1024 * 1024) }, { role: 'user', content: 'new turn only' },
    ] })
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, { method: 'POST', headers, body })
    assert.equal(response.status, 200); await response.text()
    assert.deepEqual(received, [{ type: 'text', text: 'new turn only' }])
  } finally { await new Promise((resolve) => server.close(resolve)) }
})

test('rejects requests exceeding the configured body limit', async () => {
  const token = 'local-test-token-with-at-least-32-characters'
  const server = createOpencodeProvider({ token, cwd: '/source', maxBodyBytes: 1024, router: { async prompt() { throw new Error('Unexpected prompt') } } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  try {
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-pac-session-id': 'session', 'x-pac-message-id': 'large' }
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ data: 'x'.repeat(2048) }) })
    assert.equal(response.status, 413)
  } finally { await new Promise((resolve) => server.close(resolve)) }
})

test('routes a named provider and its model to the corresponding PAC', async () => {
  const token = 'local-test-token-with-at-least-32-characters'
  let binding
  const server = createOpencodeProvider({ token, cwd: '/source', router: {
    async prompt(value, prompt, update) { binding = value; return { stopReason: 'end_turn' } },
  } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  try {
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-pac-session-id': 'session', 'x-pac-message-id': 'message', 'x-pac-provider-id': 'PAC_work' }
    const body = JSON.stringify({ model: 'sonnet', stream: true, tools: [{}], messages: [{ role: 'user', content: 'hello' }] })
    const result = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, { method: 'POST', headers, body })
    assert.equal(result.status, 200); await result.text()
    assert.deepEqual(binding, { sessionId: 'session', model: 'PAC_work/sonnet', cwd: '/source' })
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('returns confirmed PAC compaction once without a second model turn', async () => {
  const token = 'local-test-token-with-at-least-32-characters'
  let calls = 0, prompts = 0
  const server = createOpencodeProvider({ token, cwd: '/source', router: {
    async prompt() { prompts++ },
    async compact(id) { calls++; return id === 'pac-session' ? { status: 'completed', summary: 'retained context' } : null },
  } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  try {
    const native = await fetch(base + '/pac/compact', { method: 'POST', headers: auth, body: JSON.stringify({ sessionId: 'native' }) })
    assert.equal((await native.json()).handled, false)
    const result = await (await fetch(base + '/pac/compact', { method: 'POST', headers: auth, body: JSON.stringify({ sessionId: 'pac-session' }) })).json()
    assert.equal(result.handled, true)
    const headers = { ...auth, 'x-pac-session-id': 'pac-session', 'x-pac-message-id': 'compact-1' }
    const body = JSON.stringify({ model: 'PAC_work/sonnet', stream: true, messages: [{ role: 'user', content: `PAC_BRIDGE_COMPACT_RESULT:${result.nonce}\nThe following is the conversation history:` }] })
    const reply = await fetch(base + '/v1/chat/completions', { method: 'POST', headers, body })
    assert.equal(reply.status, 200)
    assert.match(await reply.text(), /retained context/)
    assert.equal((await fetch(base + '/v1/chat/completions', { method: 'POST', headers, body })).status, 400)
    assert.equal(calls, 2); assert.equal(prompts, 0)
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('routes a stop command once without prompting the model', async () => {
  const token = 'local-test-token-with-at-least-32-characters'
  const stops = []
  let prompts = 0
  const server = createOpencodeProvider({ token, cwd: '/source', router: {
    hasSession: (id) => id === 'session-1',
    async prompt() { prompts++; return { stopReason: 'end_turn' } },
    async stopTask(binding, id) { stops.push({ binding, id }); return { status: 'stop_requested' } },
  } })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-pac-session-id': 'session-1', 'x-pac-message-id': 'stop-1' }
    const body = JSON.stringify({ model: 'PAC_work/sonnet', stream: true, tools: [{}], messages: [{ role: 'user', content: 'PAC_BRIDGE_STOP_TASK pac:task' }] })
    const response = await fetch(url, { method: 'POST', headers, body })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /stop request accepted/)
    assert.equal((await fetch(url, { method: 'POST', headers, body })).status, 400)
    assert.deepEqual(stops, [{ binding: { sessionId: 'session-1', model: 'PAC_work/sonnet', cwd: '/source' }, id: 'pac:task' }])
    assert.equal(prompts, 0)
  } finally { await new Promise((resolve) => server.close(resolve)) }
})

test('routes a task stop concurrently without cancelling or replaying the active turn', async () => {
  const token = 'local-test-token-with-at-least-32-characters'
  let started, finish, calls = 0, stops = 0
  const active = new Promise(resolve => { started = resolve })
  const held = new Promise(resolve => { finish = resolve })
  const server = createOpencodeProvider({ token, cwd: '/source', router: {
    hasSession: id => id === 'session-1',
    async prompt() { calls++; started(); await held; return { stopReason: 'end_turn' } },
    async stopTask(binding, id) { assert.equal(binding.sessionId, 'session-1'); assert.equal(id, 'pac:task'); stops++; return { status: 'stop_requested' } },
  } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`
  const post = (messageId, content) => fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
    'x-pac-session-id': 'session-1', 'x-pac-message-id': messageId }, body: JSON.stringify({ model: 'PAC_work/sonnet', stream: true, tools: [{}], messages: [{ role: 'user', content }] }) })
  try {
    const turn = post('turn-1', 'start work')
    await active
    const stopped = await post('stop-1', 'PAC_BRIDGE_STOP_TASK pac:task')
    assert.equal(stopped.status, 200)
    assert.match(await stopped.text(), /stop request accepted/)
    assert.equal((await post('stop-1', 'PAC_BRIDGE_STOP_TASK pac:task')).status, 400)
    assert.equal(calls, 1); assert.equal(stops, 1)
    finish()
    assert.equal((await turn).status, 200)
    await (await turn).text()
  } finally { finish(); await new Promise(resolve => server.close(resolve)) }
})

test('independent authenticated task stop preserves the active turn and rejects replay', async () => {
  const token = 'local-test-token-with-at-least-32-characters'
  let started, finish, stops = 0, cancelled = false
  const active = new Promise(resolve => { started = resolve })
  const held = new Promise(resolve => { finish = resolve })
  const server = createOpencodeProvider({ enableExperimentalTaskStop: true, token, cwd: '/source', router: {
    hasSession: id => id === 'session-1',
    async prompt(_binding, _prompt, _update, { signal }) { signal.addEventListener('abort', () => { cancelled = true }); started(); await held; return { stopReason: 'end_turn' } },
    async stopTask(binding, taskId) {
      assert.deepEqual(binding, { sessionId: 'session-1', model: 'PAC_work/sonnet', cwd: '/source' })
      stops++
      if (taskId === 'invalid-status') return { status: 'unrecognized' }
      if (taskId !== 'owned-task') throw new Error('Unknown task private-detail')
      return { status: 'stop_requested' }
    },
  } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const stop = (body, authorization = headers) => fetch(base + '/pac/tasks/stop', { method: 'POST', headers: authorization, body: JSON.stringify(body) })
  try {
    const turn = fetch(base + '/v1/chat/completions', { method: 'POST', headers: { ...headers, 'x-pac-session-id': 'session-1', 'x-pac-message-id': 'turn-1' },
      body: JSON.stringify({ model: 'PAC_work/sonnet', stream: true, tools: [{}], messages: [{ role: 'user', content: 'start work' }] }) })
    await active
    const request = { sessionId: 'session-1', taskId: 'owned-task', requestId: 'stop-1' }
    assert.equal((await stop(request, { 'content-type': 'application/json' })).status, 401)
    assert.equal((await stop({ ...request, sessionId: 'other-session' })).status, 400)
    assert.equal((await stop({ ...request, taskId: 'bad task' })).status, 400)
    const response = await stop(request)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { status: 'stop_requested' })
    assert.equal((await stop(request)).status, 409)
    const unknown = await stop({ ...request, taskId: 'other-task', requestId: 'stop-2' })
    assert.equal(unknown.status, 502)
    assert.doesNotMatch(await unknown.text(), /private-detail/)
    assert.equal((await stop({ ...request, taskId: 'other-task', requestId: 'stop-2' })).status, 409)
    const invalidStatus = await stop({ ...request, taskId: 'invalid-status', requestId: 'stop-3' })
    assert.equal(invalidStatus.status, 502)
    assert.match(await invalidStatus.text(), /outcome is unknown/)
    assert.equal((await stop({ ...request, taskId: 'invalid-status', requestId: 'stop-3' })).status, 409)
    assert.equal(stops, 3); assert.equal(cancelled, false)
    finish()
    assert.equal((await turn).status, 200)
    await (await turn).text()
  } finally { finish(); await new Promise(resolve => server.close(resolve)) }
})

test('persistent stop guard rejects a retry after an uncertain outcome and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pac-stop-provider-'))
  const token = 'local-test-token-with-at-least-32-characters'
  let calls = 0
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      let started, finish
      const active = new Promise(resolve => { started = resolve }), held = new Promise(resolve => { finish = resolve })
      const server = createOpencodeProvider({ enableExperimentalTaskStop: true, token, cwd: '/source', stopGuard: createPacStopJournal(directory), router: {
        hasSession: () => true,
        async prompt() { started(); await held; return { stopReason: 'end_turn' } },
        async stopTask() { calls++; throw new Error('uncertain remote outcome') },
      } })
      server.listen(0, '127.0.0.1'); await once(server, 'listening')
      const base = `http://127.0.0.1:${server.address().port}`
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
      try {
        const turn = fetch(base + '/v1/chat/completions', { method: 'POST', headers: { ...headers, 'x-pac-session-id': 'session', 'x-pac-message-id': `turn-${attempt}` },
          body: JSON.stringify({ model: 'PAC_work/sonnet', stream: true, tools: [{}], messages: [{ role: 'user', content: 'start' }] }) })
        await active
        const stop = await fetch(base + '/pac/tasks/stop', { method: 'POST', headers, body: JSON.stringify({ sessionId: 'session', taskId: 'task', requestId: `request-${attempt}` }) })
        assert.equal(stop.status, attempt === 0 ? 502 : 409)
        finish(); await (await turn).text()
      } finally { finish(); await new Promise(resolve => server.close(resolve)) }
    }
    assert.equal(calls, 1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('independent stop rejects a duplicate while the original is in flight', async () => {
  const token = 'local-test-token-with-at-least-32-characters'
  let begin, finishTurn, stopStarted, finishStop, calls = 0
  const active = new Promise(resolve => { begin = resolve })
  const holdTurn = new Promise(resolve => { finishTurn = resolve })
  const stopping = new Promise(resolve => { stopStarted = resolve })
  const holdStop = new Promise(resolve => { finishStop = resolve })
  const server = createOpencodeProvider({ enableExperimentalTaskStop: true, token, cwd: '/source', router: {
    hasSession: id => id === 'session-1',
    async prompt() { begin(); await holdTurn; return { stopReason: 'end_turn' } },
    async stopTask() { calls++; stopStarted(); await holdStop; return { status: 'stopped' } },
  } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const request = JSON.stringify({ sessionId: 'session-1', taskId: 'task-1', requestId: 'stop-1' })
  const postStop = () => fetch(base + '/pac/tasks/stop', { method: 'POST', headers, body: request })
  try {
    const turn = fetch(base + '/v1/chat/completions', { method: 'POST', headers: { ...headers, 'x-pac-session-id': 'session-1', 'x-pac-message-id': 'turn-1' },
      body: JSON.stringify({ model: 'PAC_work/sonnet', stream: true, tools: [{}], messages: [{ role: 'user', content: 'start work' }] }) })
    await active
    const original = postStop()
    await stopping
    assert.equal((await postStop()).status, 409)
    assert.equal(calls, 1)
    finishStop()
    assert.deepEqual(await (await original).json(), { status: 'stopped' })
    finishTurn()
    assert.equal((await turn).status, 200)
    await (await turn).text()
  } finally { finishStop(); finishTurn(); await new Promise(resolve => server.close(resolve)) }
})

test('a failed concurrent stop does not cancel the active turn or replay the stop', async () => {
  const token = 'local-test-token-with-at-least-32-characters'
  let started, finish, stops = 0, cancelled = false
  const active = new Promise(resolve => { started = resolve })
  const held = new Promise(resolve => { finish = resolve })
  const server = createOpencodeProvider({ enableExperimentalTaskStop: true, token, cwd: '/source', router: {
    hasSession: id => id === 'session-1',
    async prompt(_binding, _prompt, _update, { signal }) { signal.addEventListener('abort', () => { cancelled = true }); started(); await held; return { stopReason: 'end_turn' } },
    async stopTask() { stops++; throw new Error('Unknown task private-detail') },
  } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`
  const post = (messageId, content) => fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
    'x-pac-session-id': 'session-1', 'x-pac-message-id': messageId }, body: JSON.stringify({ model: 'PAC_work/sonnet', stream: true, tools: [{}], messages: [{ role: 'user', content }] }) })
  try {
    const turn = post('turn-1', 'start work')
    await active
    const stop = await post('stop-1', 'PAC_BRIDGE_STOP_TASK pac:unknown')
    assert.equal(stop.status, 400)
    assert.doesNotMatch(await stop.text(), /private-detail/)
    assert.equal((await post('stop-1', 'PAC_BRIDGE_STOP_TASK pac:unknown')).status, 400)
    assert.equal(stops, 1); assert.equal(cancelled, false)
    finish()
    assert.equal((await turn).status, 200)
    await (await turn).text()
  } finally { finish(); await new Promise(resolve => server.close(resolve)) }
})

test('does not claim that a finished or unknown task accepted a stop', async () => {
  const token = 'local-test-token-with-at-least-32-characters'
  let status = 'completed'
  const server = createOpencodeProvider({ enableExperimentalTaskStop: true, token, cwd: '/source', router: {
    hasSession: () => true,
    async prompt() { throw new Error('Unexpected model prompt') },
    async stopTask() { return { status } },
  } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  try {
    const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`
    const request = (id) => fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-pac-session-id': 'session', 'x-pac-message-id': id },
      body: JSON.stringify({ model: 'PAC_work/sonnet', stream: true, tools: [{}], messages: [{ role: 'user', content: 'PAC_BRIDGE_STOP_TASK pac:task' }] }) })
    const finished = await request('completed')
    assert.equal(finished.status, 200)
    assert.match(await finished.text(), /task already completed/)
    status = 'unknown'
    const unknown = await request('unknown')
    assert.notEqual(unknown.status, 200)
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('routes a distinct user turn to its selected PAC and refuses replay', async () => {
  const calls = []
  const token = 'local-test-token-with-at-least-32-characters'
  const server = createOpencodeProvider({ token, cwd: '/source', router: {
    async prompt(binding, prompt, update) {
      calls.push({ binding, prompt })
      update({ method: '_auth/status_update', params: { secret: 'must-not-be-forwarded' } })
      update({ method: 'session/update', params: { update: { sessionUpdate: 'usage_update' } } })
      update({ method: 'session/update', params: { update: { sessionUpdate: 'available_commands_update' } } })
      update({ method: 'session/update', params: { update: { sessionUpdate: 'session_info_update', title: 'must-not-be-forwarded' } } })
      update({ method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Read', rawInput: { path: 'a.txt' }, _meta: { secret: 'must-not-be-forwarded' } } } })
      update({ method: 'opencode/session/child_update', params: { childSessionId: 'pac:child', parentSessionId: 'session-1', depth: 1, type: 'status', status: 'created', name: 'Synthetic child', background: true, secret: 'must-not-be-forwarded' } })
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
    assert.match(stream, /"reasoning_content":"synthetic thought"/)
    assert.doesNotMatch(stream, /remote slash commands are not yet available|remote authentication status changed|remote usage metrics are not yet displayed|remote session information changed/)
    assert.match(stream, /call-1/)
    assert.match(stream, /PAC subagent event/)
    assert.match(stream, /\\"background\\":true/)
    assert.match(stream, /Synthetic child/)
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
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-pac-session-id': 's', 'x-pac-message-id': 'm' },
      body: JSON.stringify({ model: 'PAC_work/sonnet', stream: true, tools: [{}], messages: [{ role: 'user', content: 'hello' }] }) })
    assert.equal(response.status, 400)
    assert.match(await response.text(), /cannot be represented/)
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

for (const failure of ['Authentication failed with private-detail', 'OAuth session expired private-detail', 'Failed to authenticate private-detail', 'Not logged in private-detail']) test(`reports an authentication-related failure without replay: ${failure.split(' private-detail')[0]}`, async () => {
  const token = 'local-test-token-with-at-least-32-characters'
  let calls = 0
  const server = createOpencodeProvider({ token, cwd: '/source', router: {
    async prompt() { calls++; throw new Error(failure) }
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
    assert.match(error, /authentication-related error; check the relay and controller sign-in/)
    assert.match(error, /review any actions already started/)
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

test('returns an actionable error when a turn fails before streaming starts', async () => {
  const token = 'local-test-token-with-at-least-32-characters'
  const server = createOpencodeProvider({ token, cwd: '/source', router: {
    async prompt() { throw new Error('Previous PAC turn outcome is unknown; reconciliation is required') },
  } })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-pac-session-id': 's', 'x-pac-message-id': 'm' },
      body: JSON.stringify({ model: 'PAC_work/sonnet', stream: true, tools: [{}], messages: [{ role: 'user', content: 'continue' }] }) })
    assert.equal(response.status, 400)
    assert.match(await response.text(), /outcome is unknown; reconcile/)
  } finally { await new Promise((resolve) => server.close(resolve)) }
})

test('explains a recovery lock without revealing internal details', async () => {
  const token = 'local-test-token-with-at-least-32-characters'
  const server = createOpencodeProvider({ token, cwd: '/source', router: {
    async prompt() { throw new Error('PAC journal is locked; do not alter an active or unreviewed session') },
  } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-pac-session-id': 's', 'x-pac-message-id': 'm' },
      body: JSON.stringify({ model: 'PAC_work/sonnet', stream: true, tools: [{}], messages: [{ role: 'user', content: 'continue' }] }) })
    assert.equal(response.status, 400)
    assert.match(await response.text(), /recovery lock is present/)
  } finally { await new Promise(resolve => server.close(resolve)) }
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

test('rejects non-boolean experimental stop configuration', () => {
  assert.throws(() => createOpencodeProvider({ token: 'local-test-token-with-at-least-32-characters', cwd: '/source',
    router: { async prompt() {} }, enableExperimentalTaskStop: 'false' }), /Invalid provider configuration/)
})

test('experimental independent task stop is disabled by default', async () => {
  const token = 'local-test-token-with-at-least-32-characters'
  let calls = 0
  const server = createOpencodeProvider({ token, cwd: '/source', router: { async prompt() {}, async stopTask() { calls++ }, hasSession: () => true } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/pac/tasks/stop`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session', taskId: 'task', requestId: 'request' }) })
    assert.equal(response.status, 404)
    assert.equal(calls, 0)
  } finally { await new Promise(resolve => server.close(resolve)) }
})
