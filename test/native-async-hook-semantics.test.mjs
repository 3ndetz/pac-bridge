import assert from 'node:assert/strict'
import { once } from 'node:events'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { query } from '@anthropic-ai/claude-agent-sdk'

test('native SDK async command continues past its configured timeout', { skip: process.env.PAC_TEST_SYNTHETIC_CLAUDE !== '1', timeout: 90000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-native-async-'))
  let requests = 0, stream
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || !request.url.startsWith('/v1/messages')) { response.writeHead(404).end(); return }
    let body = ''
    for await (const chunk of request) body += chunk
    const model = JSON.parse(body).model
    requests++
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const emit = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    emit('message_start', { message: { id: 'msg_test', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
    emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'SYNTHETIC_OK' } })
    emit('content_block_stop', { index: 0 })
    emit('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } })
    emit('message_stop', {})
    response.end()
  })
  try {
    await writeFile(join(root, 'hook.cjs'), `const f=require('fs');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{if(JSON.parse(s).prompt==='first'){const name=process.argv[2];f.writeFileSync(name+'-started','1');setTimeout(()=>f.writeFileSync(name+'-late','1'),4000)}})`)
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    async function* prompts() {
      yield { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: 'first' } }
      await new Promise(resolve => setTimeout(resolve, 7000))
      yield { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: 'second' } }
    }
    const hook = (name, timeout) => ({ type: 'command', command: process.execPath, args: [join(root, 'hook.cjs'), name], timeout, async: true })
    stream = query({ prompt: prompts(), options: { cwd: root, settingSources: [], settings: { hooks: { UserPromptSubmit: [{ hooks: [hook('short', 1), hook('control', 10)] }] } },
      env: { ...process.env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: join(root, 'claude'), ANTHROPIC_API_KEY: 'synthetic-test-key', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, NO_PROXY: '127.0.0.1,localhost', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } } })
    let firstResultBeforeCompletion = false, results = 0
    for await (const message of stream) if (message.type === 'result') {
      if (message.is_error) throw new Error('Synthetic SDK turn failed')
      if (++results === 1) firstResultBeforeCompletion = !await access(join(root, 'short-late')).then(() => true, () => false)
    }
    assert.ok(requests >= 2)
    await access(join(root, 'short-started'))
    await access(join(root, 'control-started'))
    await access(join(root, 'control-late'))
    await access(join(root, 'short-late'))
    assert.equal(firstResultBeforeCompletion, true)
  } finally {
    stream?.close()
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
