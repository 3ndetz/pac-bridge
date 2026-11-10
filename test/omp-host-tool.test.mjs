import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { spawnContained, stopContained } from '../src/spawn-contained.mjs'

test('runs, cancels and reports an OMP host tool error using a local synthetic model', { skip: !process.env.PAC_OMP_BIN, timeout: 45000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-omp-host-'))
  const agentDir = join(root, 'agent')
  await mkdir(agentDir)
  let requests = 0
  let toolIssued = false
  let sawToolResult = false
  let sawToolFailure = false
  const requestPaths = []
  const server = createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(404).end(); return }
    let body = ''
    req.on('data', (chunk) => { body += chunk.toString() })
    req.once('end', () => {
      requests++
      requestPaths.push(req.url)
      const prompt = body.includes('Use the host echo tool with hello.')
      if (body.includes('PAC_HOST_ECHO')) sawToolResult = true
      if (body.includes('PAC_HOST_FAILURE')) sawToolFailure = true
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const issue = prompt && !toolIssued
      if (issue) toolIssued = true
      const delta = issue ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_pac_test', type: 'function', function: { name: 'pac_probe_echo', arguments: '{"message":"hello"}' } }] }
        : { role: 'assistant', content: 'PAC_HOST_DONE' }
      const finish = issue ? 'tool_calls' : 'stop'
      for (const choice of [{ delta, finish_reason: null }, { delta: {}, finish_reason: finish }]) {
        res.write('data: ' + JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'pac-test', choices: [{ index: 0, ...choice }] }) + '\n\n')
      }
      res.end('data: [DONE]\n\n')
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  await writeFile(join(agentDir, 'models.yml'), JSON.stringify({ providers: { pacprobe: { baseUrl, api: 'openai-completions', apiKey: 'pac-test-placeholder',
    models: [{ id: 'pac-test', name: 'PAC test model', contextWindow: 200000, maxTokens: 8192 }] } } }))
  const child = spawnContained(process.env.PAC_OMP_BIN, ['--mode', 'rpc', '--no-session', '--model', 'pacprobe/pac-test', '--approval-mode', 'yolo'], {
    cwd: root, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: root, TMP: root, USERPROFILE: root,
      APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'), PI_CODING_AGENT_DIR: agentDir }, stdio: ['pipe', 'pipe', 'pipe']
  })
  child.stderr.resume()
  child.stdin.on('error', () => {})
  const lines = createInterface({ input: child.stdout })
  let hostCalls = 0
  let cancelledCallId
  let lastHostCallId
  let abortNext = false
  let failNext = false
  let modelReply = ''
  let sawErrorEvent = false
  const eventTypes = []
  const waiters = new Map()
  lines.on('line', (line) => {
    let event
    try { event = JSON.parse(line) } catch { return }
    eventTypes.push(event.type)
    if (event.type === 'host_tool_call') {
      hostCalls++
      lastHostCallId = event.id
      if (event.toolName === 'pac_probe_echo' && event.arguments?.message === 'hello') {
        if (abortNext) child.stdin.write(JSON.stringify({ id: 'abort', type: 'abort' }) + '\n')
        else if (failNext) child.stdin.write(JSON.stringify({ type: 'host_tool_result', id: event.id, isError: true,
          result: { content: [{ type: 'text', text: 'PAC_HOST_FAILURE' }] } }) + '\n')
        else {
          child.stdin.write(JSON.stringify({ type: 'host_tool_update', id: event.id, partialResult: { content: [{ type: 'text', text: 'PAC_HOST_PROGRESS' }] } }) + '\n')
          child.stdin.write(JSON.stringify({ type: 'host_tool_result', id: event.id, result: { content: [{ type: 'text', text: 'PAC_HOST_ECHO' }] } }) + '\n')
        }
      }
    }
    if (event.type === 'host_tool_cancel') cancelledCallId = event.targetId
    if (event.type === 'tool_execution_end' && event.isError === true) sawErrorEvent = true
    if (event.type === 'message_end') modelReply += JSON.stringify(event.message || {})
    const resolve = waiters.get(event.id)
    if (resolve && event.type === 'response') { waiters.delete(event.id); resolve(event) }
    if (event.type === 'agent_end') waiters.get('agent-end')?.(event)
  })
  const wait = (id) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(id); reject(new Error(`OMP probe timed out: ${id}`)) }, 15000)
    waiters.set(id, (event) => { clearTimeout(timer); waiters.delete(id); resolve(event) })
  })
  try {
    const registered = wait('tools')
    child.stdin.write(JSON.stringify({ id: 'tools', type: 'set_host_tools', tools: [{ name: 'pac_probe_echo', label: 'PAC probe',
      description: 'Echo a test value', loadMode: 'essential', parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } }] }) + '\n')
    assert.equal((await registered).success, true)
    const done = wait('agent-end')
    child.stdin.write(JSON.stringify({ id: 'prompt', type: 'prompt', message: 'Use the host echo tool with hello.' }) + '\n')
    await done
    assert.equal(hostCalls, 1, JSON.stringify({ requests, requestPaths, eventTypes, toolIssued, modelReplyFlags: ['error', 'invalid', 'failed', 'tool', 'PAC_HOST_DONE'].filter((word) => modelReply.includes(word)) }))
    assert.equal(sawToolResult, true)
    assert.ok(eventTypes.includes('tool_execution_update'))
    assert.match(modelReply, /PAC_HOST_DONE/)
    toolIssued = false
    abortNext = true
    const cancelled = wait('agent-end')
    child.stdin.write(JSON.stringify({ id: 'prompt-cancel', type: 'prompt', message: 'Use the host echo tool with hello.' }) + '\n')
    await cancelled
    assert.equal(hostCalls, 2)
    assert.equal(typeof lastHostCallId, 'string')
    assert.equal(cancelledCallId, lastHostCallId)
    toolIssued = false
    abortNext = false
    failNext = true
    const failed = wait('agent-end')
    child.stdin.write(JSON.stringify({ id: 'prompt-error', type: 'prompt', message: 'Use the host echo tool with hello.' }) + '\n')
    await failed
    assert.equal(hostCalls, 3)
    assert.equal(sawToolFailure, true)
    assert.equal(sawErrorEvent, true)
  } finally {
    const exited = child.exitCode === null ? once(child, 'close') : Promise.resolve()
    lines.close()
    stopContained(child)
    await exited
    await new Promise((resolve) => server.close(resolve))
    const actual = await realpath(root)
    const local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-omp-host-')) await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
