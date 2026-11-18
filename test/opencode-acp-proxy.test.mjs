import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, relative, sep } from 'node:path'
import { spawnContained, stopContained } from '../src/spawn-contained.mjs'
import { createOpencodeAcpProxy } from '../src/opencode-acp-proxy.mjs'

const send = x => JSON.stringify(x) + '\n'
const wait = () => new Promise(r => setTimeout(r, 25))
async function until(check, timeout = 10000) { const deadline = Date.now() + timeout; while (!check()) { if (Date.now() >= deadline) throw new Error('Test condition timed out'); await wait() } }
async function withDeadline(promise, ms, message) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })]) } finally { clearTimeout(timer) } }
async function removeOwnedRoot(root, prefix) {
  const actual = await realpath(root), base = await realpath(tmpdir()), local = relative(base, actual)
  if (!local.startsWith(prefix) || isAbsolute(local) || local.includes(sep)) throw new Error('Unsafe test cleanup path')
  for (let attempt = 0; ; attempt++) {
    try { await rm(actual, { recursive:true, force:true }); return }
    catch (error) { if (!['EBUSY','EPERM','ENOTEMPTY'].includes(error.code) || attempt >= 9) throw error; await new Promise(r => setTimeout(r, 300)) }
  }
}
test('proxy preserves ACP frames and routes stop concurrently with a parent prompt', async () => {
  const requests = []; let finish
  const server = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c
    requests.push({ auth: req.headers.authorization, body: JSON.parse(body) })
    await new Promise(r => { finish = r }); res.end(JSON.stringify({ status: 'stop_requested' }))
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const input = new PassThrough(), output = new PassThrough(), ci = new PassThrough(), co = new PassThrough()
  let upstream = '', downstream = ''; ci.on('data', c => upstream += c); output.on('data', c => downstream += c)
  const proxy = createOpencodeAcpProxy({ input, output, childInput: ci, childOutput: co, providerUrl: `http://127.0.0.1:${server.address().port}`, token: 'secret' })
  try {
  const open = send({ jsonrpc:'2.0', id:1, method:'session/new', params:{} })
  input.write(open.slice(0, 4)); input.write(open.slice(4))
  const opened = send({jsonrpc:'2.0', id:1, result:{sessionId:'session-a'}})
  co.write(opened.slice(0, 9)); co.write(opened.slice(9)); await wait()
  const prompt = send({jsonrpc:'2.0', id:2, method:'session/prompt', params:{sessionId:'session-a'}})
  const stop = send({jsonrpc:'2.0', id:3, method:'pac/tasks/stop', params:{sessionId:'session-a',taskId:'task'}})
  input.write(prompt + stop)
  const update = send({jsonrpc:'2.0', method:'session/update', params:{sessionId:'session-a', text:'Привет'}})
  co.write(update); await until(() => requests.length === 1 && downstream.includes(update))
  assert.equal(upstream, open + prompt); assert.equal(downstream, opened + update)
  assert.equal(requests.length, 1); assert.equal(requests[0].auth, 'Bearer secret'); assert.equal(requests[0].body.sessionId, 'session-a')
  finish(); await until(() => downstream.length > (opened + update).length); assert.equal(JSON.parse(downstream.slice((opened + update).length)).result.status, 'stop_requested')
  } finally { finish?.(); proxy.close(); server.closeAllConnections(); await new Promise(r => server.close(r)) }
})

test('rejects unowned sessions and reports uncertain provider outcomes without leaking secrets', async () => {
  const input = new PassThrough(), output = new PassThrough(), ci = new PassThrough(), co = new PassThrough()
  let got = ''; output.on('data', c => got += c); ci.resume()
  const proxy = createOpencodeAcpProxy({ input, output, childInput: ci, childOutput: co, providerUrl: 'http://127.0.0.1:1', token:'secret' })
  input.write(send({jsonrpc:'2.0', id:1, method:'session/load', params:{sessionId:'owned'}}))
  co.write(send({jsonrpc:'2.0',id:1,result:{}})); await wait()
  input.write(send({jsonrpc:'2.0',id:2,method:'pac/tasks/stop',params:{sessionId:'other',taskId:'x'}}) + send({jsonrpc:'2.0',id:3,method:'pac/tasks/stop',params:{sessionId:'owned',taskId:'x'}}))
  await until(() => got.includes('outcome is unknown'))
  const messages = got.trim().split('\n').map(JSON.parse)
  assert.match(messages.find(x => x.id === 2).error.message, /Unknown/)
  assert.match(messages.find(x => x.id === 3).error.message, /outcome is unknown/)
  assert.ok(!got.includes('secret')); proxy.close()
})

test('oversized incomplete input fails closed', async () => {
  const input = new PassThrough(), output = new PassThrough(), ci = new PassThrough(), co = new PassThrough()
  ci.resume(); output.resume()
  createOpencodeAcpProxy({ input, output, childInput: ci, childOutput: co, providerUrl:'http://127.0.0.1:1', token:'secret', maxLineBytes:8 })
  input.write('123456789'); await wait(); assert.equal(ci.destroyed, true)
})

test('proxy reaches actual provider and session router during a live turn', async () => {
  const { createOpencodeProvider } = await import('../src/opencode-provider.mjs')
  const { createOpencodeSessionRouter } = await import('../src/opencode-session-router.mjs')
  let started, finish, stopped = 0, cancelled = 0
  const active = new Promise(r => { started = r }), held = new Promise(r => { finish = r })
  const router = createOpencodeSessionRouter({ openSession: async () => ({
    async prompt() { started(); await held; return { stopReason:'end_turn' } },
    async stopTask(id) { assert.equal(id, 'task'); stopped++; return { status:'stop_requested' } },
    cancel() { cancelled++ }, close() {},
  }) })
  const token = 'local-test-token-with-at-least-32-characters'
  const server = createOpencodeProvider({ enableExperimentalTaskStop: true, router, token, cwd:'/source' })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const input = new PassThrough(), output = new PassThrough(), ci = new PassThrough(), co = new PassThrough()
  ci.resume(); let received = ''; output.on('data', c => received += c)
  const proxy = createOpencodeAcpProxy({ input, output, childInput:ci, childOutput:co, providerUrl:base, token })
  try {
    input.write(send({jsonrpc:'2.0',id:1,method:'session/new',params:{}}))
    co.write(send({jsonrpc:'2.0',id:1,result:{sessionId:'session-1'}})); await wait()
    const turn = fetch(base + '/v1/chat/completions', { method:'POST', headers:{ authorization:`Bearer ${token}`, 'content-type':'application/json', 'x-pac-session-id':'session-1', 'x-pac-message-id':'message-1' }, body:JSON.stringify({model:'PAC_work/sonnet',stream:true,tools:[{}],messages:[{role:'user',content:'hello'}]}) })
    await Promise.race([active, turn.then(() => { throw new Error('Turn ended before becoming active') })])
    input.write(send({jsonrpc:'2.0',id:2,method:'pac/tasks/stop',params:{sessionId:'session-1',taskId:'task'}}))
    await until(() => stopped === 1 && received.includes('stop_requested'))
    assert.equal(stopped, 1)
    assert.equal(received.trim().split('\n').map(JSON.parse).find(x => x.id === 2).result.status, 'stop_requested')
    assert.equal(cancelled, 0); finish(); await (await turn).text()
  } finally { finish(); proxy.close(); router.close(); server.closeAllConnections(); await new Promise(r => server.close(r)) }
})

test('native OpenCode ACP session matches provider header', { skip: !process.env.PAC_TEST_NATIVE_OPENCODE, timeout: 45000 }, async () => {
  const { Duplex } = await import('node:stream')
  const { mkdtemp } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { createAcpPeer } = await import('../src/acp-peer.mjs')
  const root = await mkdtemp(join(tmpdir(), 'pac-native-session-'))
  let gotHeader, seen
  const requestSeen = new Promise(r => { seen = r })
  const server = createServer(async (req, res) => { for await (const _ of req) {} gotHeader = req.headers['x-pac-session-id']; seen(); res.writeHead(500, {'content-type':'application/json'}); res.end('{"error":{"message":"fixture"}}') })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const plugin = new URL('../adapters/opencode-plugin.mjs', import.meta.url).href
  const config = { plugin:[plugin], provider:{pacbridge:{npm:'@ai-sdk/openai-compatible', name:'fixture', options:{baseURL:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'fixture'},models:{'PAC_test/model':{name:'fixture'}}}} }
  const child = spawnContained(process.env.PAC_TEST_NATIVE_OPENCODE, ['acp'], { cwd:root, env:{...process.env, OPENCODE_CONFIG_CONTENT:JSON.stringify(config)}, stdio:['pipe','pipe','pipe'], windowsHide:true })
  const childClosed = new Promise(resolve => child.once('close', resolve))
  child.on('error', () => {})
  child.stderr.resume()
  const peer = createAcpPeer(Duplex.from({readable:child.stdout,writable:child.stdin}), {onRequest:()=>({}),timeoutMs:20000})
  try {
    await peer.call('initialize', {protocolVersion:1,clientCapabilities:{}})
    const session = await peer.call('session/new', {cwd:root,mcpServers:[]})
    await peer.call('session/set_config_option', {sessionId:session.sessionId,configId:'model',value:'pacbridge/PAC_test/model'})
    const prompt = peer.call('session/prompt',{sessionId:session.sessionId,prompt:[{type:'text',text:'fixture'}]},20000).catch(()=>{})
    await withDeadline(requestSeen, 15000, 'provider request not observed')
    assert.equal(gotHeader, session.sessionId)
    await prompt
  } finally {
    try { peer.close(); stopContained(child); await withDeadline(childClosed, 15000, 'native child did not close') }
    finally { server.closeAllConnections(); await new Promise(r=>server.close(r)); await removeOwnedRoot(root, 'pac-native-session-') }
  }
})

test('stop reply never splits a fragmented child message', async () => {
  const input = new PassThrough(), output = new PassThrough(), ci = new PassThrough(), co = new PassThrough()
  ci.resume(); let got = ''; output.on('data', c => got += c)
  const proxy = createOpencodeAcpProxy({input,output,childInput:ci,childOutput:co,providerUrl:'http://127.0.0.1:1',token:'secret'})
  const frame = send({jsonrpc:'2.0',method:'session/update',params:{text:'fragmented'}})
  co.write(frame.slice(0, 12)); input.write(send({jsonrpc:'2.0',id:5,method:'pac/tasks/stop',params:{sessionId:'unowned',taskId:'x'}})); await wait()
  co.write(frame.slice(12)); await wait()
  const messages = got.trim().split('\n').map(JSON.parse)
  assert.equal(messages.length, 2); assert.equal(messages[0].id, 5); assert.equal(messages[1].params.text, 'fragmented'); proxy.close()
})

test('fatal oversized ACP frame terminates the actual launcher and contained native child', {skip: !process.env.PAC_TEST_NATIVE_OPENCODE, timeout:45000}, async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = await mkdtemp(join(tmpdir(), 'pac-proxy-fatal-'))
  const child = spawnContained(process.execPath, [fileURLToPath(new URL('../adapters/opencode-pac.mjs', import.meta.url)), 'acp'], {
    cwd:root, env:{...process.env, PAC_EXPERIMENTAL:'1', PAC_MODEL:'', PAC_OPENCODE_BINARY:process.env.PAC_TEST_NATIVE_OPENCODE, PAC_NAME:'fixture', PAC_RELAY_URL:'ws://127.0.0.1:1', PAC_SOURCE_TOKEN_FILE:join(root,'missing'), PAC_CONTROLLER_CWD:root, PAC_SESSION_DIR:join(root,'sessions')}, stdio:['pipe','pipe','pipe'], windowsHide:true })
  const childClosed = once(child, 'close')
  let stderr = ''; child.stdout.resume(); child.stderr.on('data', c => stderr += c); child.stdin.on('error',()=>{})
  try {
    await new Promise(r => setTimeout(r,4000))
    assert.equal(child.exitCode, null, 'launcher exited before framing test')
    child.stdin.write(Buffer.alloc(16 * 1024 * 1024 + 1, 65))
    const [code] = await withDeadline(once(child, 'exit'), 15000, 'launcher did not exit')
    assert.notEqual(code, 0); assert.match(stderr, /PAC ACP proxy transport or framing failure/)
  } finally { stopContained(child); await childClosed; await removeOwnedRoot(root, 'pac-proxy-fatal-') }
})

test('rejects unowned sessions and duplicate in-flight stop without dispatching again', async () => {
  const requests = []; let release
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    requests.push(JSON.parse(raw)); await new Promise(resolve => { release = resolve })
    res.end(JSON.stringify({status:'stop_requested'}))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const input = new PassThrough(), output = new PassThrough(), childInput = new PassThrough(), childOutput = new PassThrough()
  childInput.resume(); let outputText = ''; output.on('data', chunk => outputText += chunk)
  const proxy = createOpencodeAcpProxy({input, output, childInput, childOutput, providerUrl:`http://127.0.0.1:${server.address().port}`, token:'synthetic'})
  try {
    input.write(send({jsonrpc:'2.0',id:1,method:'session/new',params:{}}))
    childOutput.write(send({jsonrpc:'2.0',id:1,result:{sessionId:'owner'}}))
    await until(() => outputText.includes('owner'))
    const stop = send({jsonrpc:'2.0',id:2,method:'pac/tasks/stop',params:{sessionId:'owner',taskId:'owned-task'}})
    input.write(stop); await until(() => requests.length === 1)
    input.write(stop + send({jsonrpc:'2.0',id:3,method:'pac/tasks/stop',params:{sessionId:'foreign',taskId:'owned-task'}}))
    await until(() => outputText.includes('Duplicate PAC stop request') && outputText.includes('Unknown or invalid PAC session'))
    assert.equal(requests.length,1); assert.equal(requests[0].sessionId,'owner')
    release(); await until(() => outputText.includes('stop_requested'))
    input.write(stop); await until(() => (outputText.match(/Duplicate PAC stop request/g) || []).length === 2)
    assert.equal(requests.length,1)
  } finally { release?.(); proxy.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})

test('two active sessions reject a foreign task and a duplicate stop without repeating the native call', async () => {
  const { createOpencodeProvider } = await import('../src/opencode-provider.mjs')
  const { createOpencodeSessionRouter } = await import('../src/opencode-session-router.mjs')
  const { stopNativeTask } = await import('../src/native-task-stop.mjs')
  let releaseTurns, releaseStop, calls = 0
  const heldTurns = new Promise(resolve => { releaseTurns = resolve }), heldStop = new Promise(resolve => { releaseStop = resolve })
  const started = new Set()
  const router = createOpencodeSessionRouter({openSession:async ({sessionId}) => {
    const session = { nativeSubagentRuntime:{children:new Map([[`task-${sessionId}`, {sessionId:`task-${sessionId}`} ]])}, query:{async stopTask() { calls++; await heldStop }} }
    return {async prompt() { started.add(sessionId); await heldTurns; return {stopReason:'end_turn'} }, async stopTask(id) { return stopNativeTask(session,id) }, cancel(){}, close(){} }
  }})
  const token='synthetic-provider-token-32-characters-long'
  const server=createOpencodeProvider({ enableExperimentalTaskStop: true,router,token,cwd:'/fixture'})
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
  const base=`http://127.0.0.1:${server.address().port}`
  const input=new PassThrough(), output=new PassThrough(), childInput=new PassThrough(), childOutput=new PassThrough()
  childInput.resume(); let text=''; output.on('data',chunk => text += chunk)
  const proxy=createOpencodeAcpProxy({input,output,childInput,childOutput,providerUrl:base,token})
  const turn = id => fetch(base+'/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','x-pac-session-id':id,'x-pac-message-id':'turn'},body:JSON.stringify({model:'PAC_test/model',stream:true,tools:[{}],messages:[{role:'user',content:'test'}]})})
  try {
    for (const [id,sessionId] of [[1,'a'],[2,'b']]) { input.write(send({jsonrpc:'2.0',id,method:'session/new',params:{}})); childOutput.write(send({jsonrpc:'2.0',id,result:{sessionId}})) }
    await until(() => text.includes('"sessionId":"b"'))
    const a=turn('a'), b=turn('b'); await until(() => started.size === 2)
    input.write(send({jsonrpc:'2.0',id:3,method:'pac/tasks/stop',params:{sessionId:'b',taskId:'task-a'}}))
    await until(() => text.includes('outcome is unknown')); assert.equal(calls,0)
    const stop=send({jsonrpc:'2.0',id:4,method:'pac/tasks/stop',params:{sessionId:'a',taskId:'task-a'}})
    input.write(stop); await until(() => calls===1); input.write(stop)
    await until(() => text.includes('Duplicate PAC stop request')); assert.equal(calls,1)
    releaseStop(); await until(() => text.includes('stop_requested')); assert.equal(calls,1)
    releaseTurns(); await Promise.all([(await a).text(),(await b).text()])
  } finally { releaseStop(); releaseTurns(); proxy.close(); router.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})

test('publishes only session-owned structured task snapshots without rewriting child frames', async () => {
  const input=new PassThrough(), output=new PassThrough(), childInput=new PassThrough(), childOutput=new PassThrough()
  childInput.resume(); let text=''; output.on('data', chunk => text += chunk)
  const proxy=createOpencodeAcpProxy({input,output,childInput,childOutput,providerUrl:'http://127.0.0.1:1',token:'never-emit'})
  try {
    input.write(send({jsonrpc:'2.0',id:1,method:'session/new',params:{}}))
    childOutput.write(send({jsonrpc:'2.0',id:1,result:{sessionId:'owner'}}))
    await until(() => text.includes('"sessionId":"owner"'))
    assert.throws(() => proxy.publishBackgroundTasks('foreign',[]), /unowned/)
    assert.throws(() => proxy.publishBackgroundTasks('owner',[{task_id:'a',task_type:'shell',description:42}]), /Invalid/)
    assert.throws(() => proxy.publishBackgroundTasks('owner',[{task_type:'shell',description:'missing'}]), /Invalid/)
    assert.throws(() => proxy.publishBackgroundTasks('owner',[{task_id:' ',task_type:'shell',description:''}]), /Invalid/)
    assert.throws(() => proxy.publishBackgroundTasks('owner',[{task_id:'a',task_type:'  ',description:''}]), /Invalid/)
    assert.throws(() => proxy.publishBackgroundTasks('owner',[{task_id:'a',task_type:'shell',description:''},{task_id:'a',task_type:'agent',description:''}]), /Invalid/)
    const frame=send({jsonrpc:'2.0',method:'session/update',params:{text:'partial'}})
    childOutput.write(frame.slice(0,8))
    proxy.publishBackgroundTasks('owner',[{task_id:'task-1',task_type:'agent',description:'work',secret:'must-not-leak'}])
    childOutput.write(frame.slice(8))
    await until(() => text.includes('partial'))
    const messages=text.trim().split('\n').map(JSON.parse), event=messages.find(message=>message.method==='pac/background_tasks_changed')
    assert.deepEqual(event.params,{rootSessionId:'owner',tasks:[{task_id:'task-1',task_type:'agent',description:'work'}]})
    assert.equal(messages.at(-1).params.text,'partial'); assert.ok(!text.includes('must-not-leak')); assert.ok(!text.includes('never-emit'))
    proxy.publishBackgroundTasks('owner',[])
    await until(() => text.includes('"tasks":[]'))
  } finally { proxy.close() }
})

test('actual provider delivers normalized snapshots through the owning ACP proxy session', async () => {
  const { createOpencodeProvider } = await import('../src/opencode-provider.mjs')
  const token='test-provider-token-at-least-32-characters', input=new PassThrough(), output=new PassThrough(), childInput=new PassThrough(), childOutput=new PassThrough()
  childInput.resume(); let received=''; output.on('data',chunk => received += chunk)
  let proxy
  const server=createOpencodeProvider({token,cwd:'/fixture',onBackgroundTasks:(sessionId,tasks)=>proxy.publishBackgroundTasks(sessionId,tasks),router:{async prompt(_binding,_prompt,update){update({method:'pac/background_tasks_changed',params:{tasks:[{task_id:'owned',task_type:'agent',description:'working',secret:'ignored'}]}});return {stopReason:'end_turn'}}}})
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
  const base=`http://127.0.0.1:${server.address().port}`
  proxy=createOpencodeAcpProxy({input,output,childInput,childOutput,providerUrl:base,token})
  try {
    input.write(send({jsonrpc:'2.0',id:1,method:'session/new',params:{}}));childOutput.write(send({jsonrpc:'2.0',id:1,result:{sessionId:'owner'}}))
    await until(()=>received.includes('"sessionId":"owner"'))
    const response=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','x-pac-session-id':'owner','x-pac-message-id':'turn'},body:JSON.stringify({model:'PAC_test/model',stream:true,tools:[{}],messages:[{role:'user',content:'test'}]})})
    assert.equal(response.status,200);await response.text();await until(()=>received.includes('pac/background_tasks_changed'))
    const event=received.trim().split('\n').map(JSON.parse).find(x=>x.method==='pac/background_tasks_changed')
    assert.deepEqual(event.params,{rootSessionId:'owner',tasks:[{task_id:'owned',task_type:'agent',description:'working'}]});assert.ok(!received.includes('ignored'));assert.ok(!received.includes(token))
  } finally {proxy.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})
test('test-only ready handshake returns only session-owned unknown availability', async () => {
  const input=new PassThrough(), output=new PassThrough(), childInput=new PassThrough(), childOutput=new PassThrough()
  let out='', forwarded=''; output.on('data', chunk => out += chunk); childInput.on('data', chunk => forwarded += chunk)
  const epoch='01234567-89ab-4cde-8abc-0123456789ab', calls=[]
  const proxy=createOpencodeAcpProxy({input,output,childInput,childOutput,providerUrl:'http://127.0.0.1:1',token:'secret',onSnapshotReady:async sessionId => { calls.push(sessionId); return {epoch,availability:'unknown'} }})
  try {
    input.write(send({jsonrpc:'2.0',id:1,method:'session/new',params:{}}))
    childOutput.write(send({jsonrpc:'2.0',id:1,result:{sessionId:'owner'}}))
    await until(() => out.includes('owner'))
    input.write(send({jsonrpc:'2.0',id:2,method:'pac/background_tasks/ready',params:{sessionId:'foreign'}}))
    await until(() => out.includes('Unknown or invalid PAC session'))
    assert.deepEqual(calls, [])
    input.write(send({jsonrpc:'2.0',id:3,method:'pac/background_tasks/ready',params:{sessionId:'owner'}}))
    await until(() => out.includes('unknown'))
    const reply=out.trim().split('\n').map(JSON.parse).find(value => value.id===3)
    assert.deepEqual(reply.result,{rootSessionId:'owner',epoch,availability:'unknown'})
    assert.deepEqual(calls,['owner']); assert.equal(forwarded.includes('pac/background_tasks/ready'),false)
    assert.throws(() => proxy.publishBackgroundAvailability('foreign',{epoch,availability:'unknown'}), /unowned/)
    proxy.publishBackgroundAvailability('owner',{epoch,availability:'unknown'})
    await until(() => out.includes('pac/background_availability'))
  } finally { proxy.close() }
})


test('tool updates reach only an active owned ACP prompt and retain exact tool data', async () => {
  const input = new PassThrough(), output = new PassThrough(), ci = new PassThrough(), co = new PassThrough()
  const frames = []; output.on('data', raw => frames.push(...raw.toString().trim().split('\n').map(JSON.parse))); ci.resume()
  const proxy = createOpencodeAcpProxy({ input, output, childInput: ci, childOutput: co, providerUrl: 'http://127.0.0.1:1', token: 'secret' })
  const tool = { sessionUpdate: 'tool_call', toolCallId: 'read-1', title: 'Read', kind: 'read', status: 'pending', rawInput: { file_path: 'C:\\source\\file.txt' }, _meta: { secret: 'private' } }
  try {
    assert.throws(() => proxy.publishToolUpdate('owned', tool), /inactive/)
    input.write(send({jsonrpc:'2.0',id:101,method:'session/load',params:{sessionId:'owned'}}))
    co.write(send({jsonrpc:'2.0',id:101,result:{}})); await wait()
    assert.throws(() => proxy.publishToolUpdate('owned', tool), /inactive/)
    input.write(send({jsonrpc:'2.0',id:102,method:'session/prompt',params:{sessionId:'owned'}})); await wait()
    assert.throws(() => proxy.publishToolUpdate('other', tool), /inactive/)
    proxy.publishToolUpdate('owned', tool)
    const result = {sessionUpdate:'tool_call_update',toolCallId:'read-1',status:'completed',rawOutput:'line 1\n"quoted"\n'}
    proxy.publishToolUpdate('owned', result)
    await wait()
    const events = frames.filter(x => x.method === 'session/update')
    assert.equal(events.length, 2); assert.equal(events[0].params.sessionId, 'owned')
    assert.deepEqual(events[0].params.update.rawInput, tool.rawInput)
    assert.equal(events[0].params.update._meta, undefined)
    assert.equal(events[1].params.update.rawOutput, result.rawOutput)
    co.write(send({jsonrpc:'2.0',id:102,result:{stopReason:'end_turn'}})); await wait()
    assert.throws(() => proxy.publishToolUpdate('owned', result), /inactive/)
  } finally { proxy.close() }
})


test('provider publishes concurrent source tool events through their original ACP sessions', async () => {
  const { createOpencodeProvider } = await import('../src/opencode-provider.mjs')
  const input=new PassThrough(), output=new PassThrough(), ci=new PassThrough(), co=new PassThrough()
  ci.resume(); const frames=[]; output.on('data',raw=>frames.push(...raw.toString().trim().split('\n').map(JSON.parse)))
  const token='local-test-token-with-at-least-32-characters'
  const proxy=createOpencodeAcpProxy({input,output,childInput:ci,childOutput:co,providerUrl:'http://127.0.0.1:1',token})
  let calls=0
  const server=createOpencodeProvider({token,cwd:'/fixture',onToolUpdate:(sid,event)=>proxy.publishToolUpdate(sid,event),router:{
    async prompt(binding,_prompt,update) {
      calls++; const id='read-'+binding.sessionId
      update({method:'session/update',params:{update:{sessionUpdate:'tool_call',toolCallId:id,title:'Read',kind:'read',status:'pending'}}})
      await wait()
      update({method:'session/update',params:{update:{sessionUpdate:'tool_call_update',toolCallId:id,status:'completed',rawOutput:binding.sessionId+'-only'}}})
      update({method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'done'}}}})
      return {stopReason:'end_turn'}
    },cancel() {},
  }})
  server.listen(0,'127.0.0.1'); await once(server,'listening')
  try {
    for (const [i,sid] of [[1,'source-a'],[2,'source-b']]) {
      input.write(send({jsonrpc:'2.0',id:i,method:'session/load',params:{sessionId:sid}}));co.write(send({jsonrpc:'2.0',id:i,result:{}}))
    }
    await wait()
    for(const [id,sid] of [[3,'source-a'],[4,'source-b']])input.write(send({jsonrpc:'2.0',id,method:'session/prompt',params:{sessionId:sid}}))
    await wait()
    const streams=await Promise.all(['source-a','source-b'].map(async sid=>{
      const response=await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','x-pac-session-id':sid,'x-pac-message-id':'turn-'+sid},body:JSON.stringify({model:'PAC_work/sonnet',stream:true,tools:[{}],messages:[{role:'user',content:'read'}]})})
      assert.equal(response.status,200);return response.text()
    }))
    assert.equal(calls,2)
    for(const stream of streams){assert.match(stream,/done/);assert.doesNotMatch(stream,/PAC tool event|read-source|only/)}
    const updates=frames.filter(f=>f.method==='session/update');assert.equal(updates.length,4)
    for(const f of updates){assert.equal(f.params.update.toolCallId,'read-'+f.params.sessionId);if(f.params.update.status==='completed')assert.equal(f.params.update.rawOutput,f.params.sessionId+'-only')}
  } finally { proxy.close();await new Promise(r=>server.close(r)) }
})


test('native prompt completion closes only its own interrupted visible tools', async () => {
  const input=new PassThrough(),output=new PassThrough(),ci=new PassThrough(),co=new PassThrough();ci.resume()
  const frames=[];output.on('data',raw=>frames.push(...raw.toString().trim().split('\n').map(JSON.parse)))
  const proxy=createOpencodeAcpProxy({input,output,childInput:ci,childOutput:co,providerUrl:'http://127.0.0.1:1',token:'fixture'})
  try{
    for(const [id,sid] of [[1,'first'],[2,'second']]){input.write(send({jsonrpc:'2.0',id,method:'session/load',params:{sessionId:sid}}));co.write(send({jsonrpc:'2.0',id,result:{}}))}
    await wait()
    for(const [id,sid] of [[3,'first'],[4,'second']])input.write(send({jsonrpc:'2.0',id,method:'session/prompt',params:{sessionId:sid}}))
    await wait()
    for(const sid of ['first','second'])proxy.publishToolUpdate(sid,{sessionUpdate:'tool_call',toolCallId:'call-'+sid,status:'pending',title:'Read',kind:'read'})
    co.write(send({jsonrpc:'2.0',id:3,result:{stopReason:'cancelled'}}));await wait()
    const failed=frames.filter(f=>f.params?.update?.status==='failed');assert.equal(failed.length,1);assert.equal(failed[0].params.sessionId,'first');assert.match(failed[0].params.update.rawOutput,/Review its outcome/)
    proxy.publishToolUpdate('second',{sessionUpdate:'tool_call_update',toolCallId:'call-second',status:'completed'})
    co.write(send({jsonrpc:'2.0',id:4,result:{stopReason:'end_turn'}}));await wait()
    assert.equal(frames.filter(f=>f.params?.update?.status==='failed').length,1)
  }finally{proxy.close()}
})

test('negotiated ACP forms return answers to the original PAC turn and cancel without replay', async () => {
  const { createOpencodeProvider } = await import('../src/opencode-provider.mjs')
  const input = new PassThrough(), output = new PassThrough(), childInput = new PassThrough(), childOutput = new PassThrough()
  const frames = [], forwarded = []
  output.on('data', raw => frames.push(...raw.toString().trim().split('\n').map(JSON.parse)))
  childInput.on('data', raw => forwarded.push(...raw.toString().trim().split('\n').map(JSON.parse)))
  const token = 'synthetic-provider-token-32-characters-long'
  const proxy = createOpencodeAcpProxy({ input, output, childInput, childOutput, providerUrl: 'http://127.0.0.1:1', token })
  const questions = [{ question: 'Choose values', header: 'Fixture', multiSelect: true,
    options: [{ label: 'one', description: 'A' }, { label: 'two', description: 'B' }] }]
  const approvals = []
  const server = createOpencodeProvider({ token, cwd: '/fixture',
    requestQuestionForm: (sessionId, id, form, options) => proxy.requestQuestionForm(sessionId, id, form, options),
    router: {
      async prompt(binding, _prompt, update) {
        approvals.push(await server.requestPermission(binding.sessionId, {
          toolCall: { toolCallId: 'question-' + binding.sessionId, rawInput: { questions } },
          options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }],
          _meta: { pac: { question: true } },
        }))
        update({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'continued' } } } })
        return { stopReason: 'end_turn' }
      },
      cancel() {},
    },
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const post = (sid) => fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
      'x-pac-session-id': sid, 'x-pac-message-id': 'prompt-' + sid },
    body: JSON.stringify({ model: 'PAC_fixture/model', stream: true, tools: [{ function: { name: 'read' } }],
      messages: [{ role: 'user', content: 'test' }] }),
  })
  const outgoingForms = () => frames.filter(frame => frame.method === 'elicitation/create')
  try {
    assert.equal(proxy.supportsQuestionForms(), false)
    input.write(send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientCapabilities: { elicitation: { form: {} } } } }))
    for (const [id, sessionId] of [[2, 'first'], [3, 'second']]) {
      input.write(send({ jsonrpc: '2.0', id, method: 'session/load', params: { sessionId } }))
      childOutput.write(send({ jsonrpc: '2.0', id, result: {} }))
    }
    await until(() => proxy.supportsQuestionForms() && frames.some(frame => frame.id === 3))
    assert.throws(() => proxy.requestQuestionForm('other', 'tool', questions, { timeoutMs: 1000 }), /unavailable/)
    for (const [id, sessionId] of [[4, 'first'], [5, 'second']]) {
      input.write(send({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId } }))
    }
    const first = post('first')
    await until(() => outgoingForms().length === 1)
    const second = post('second')
    await until(() => outgoingForms().length === 2)
    const [submitted, cancelled] = outgoingForms()
    assert.equal(submitted.params.sessionId, 'first')
    assert.deepEqual(submitted.params.requestedSchema.properties.q0.items.anyOf.map(option => option.const), ['one', 'two'])
    assert.equal(cancelled.params.sessionId, 'second')
    const answers = { 0: ['one', 'free text'] }
    const response = { action: 'accept', content: { q0: ['one'], q0_custom: 'free text' } }
    input.write(send({ jsonrpc: '2.0', id: submitted.id, result: response }))
    input.write(send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'second' } }))
    input.write(send({ jsonrpc: '2.0', id: cancelled.id, result: response }))
    for (const http of await Promise.all([first, second])) {
      assert.equal(http.status, 200)
      assert.match(await http.text(), /continued/)
    }
    assert.deepEqual(approvals, [
      { outcome: { outcome: 'selected', optionId: 'yes' }, _meta: { pac: { answers } } },
      { outcome: { outcome: 'selected', optionId: 'no' } },
    ])
    assert.ok(!forwarded.some(frame => frame.id === submitted.id || frame.id === cancelled.id))
  } finally {
    proxy.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})
