import test from 'node:test'
import assert from 'node:assert/strict'
import { Duplex } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAcpPeer } from '../src/acp-peer.mjs'
import { spawnContained, stopContained } from '../src/spawn-contained.mjs'

test('test-only router returns unknown snapshot bound to its source session', { skip: process.platform !== 'linux', timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-snapshot-router-'))
  const router = fileURLToPath(new URL('../adapters/pac-opencode-router.mjs', import.meta.url))
  const fake = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))
  const env = { ...process.env, PAC_EXPERIMENTAL:'1', PAC_TEST_SNAPSHOT_CHANNEL:'1', PAC_OPENCODE_BINARY:process.execPath, PAC_NAME:'fixture', PAC_RELAY_URL:'ws://127.0.0.1:1', PAC_SOURCE_TOKEN_FILE:join(root,'missing'), PAC_CONTROLLER_CWD:root }
  delete env.PAC_ENDPOINTS_FILE
  const child = spawnContained(process.execPath, [router, fake, '--native'], { cwd:root, env, stdio:['pipe','pipe','pipe'], windowsHide:true })
  child.on('error', () => {})
  child.stderr.resume()
  const closed = new Promise(resolve => child.once('close', resolve))
  const peer = createAcpPeer(Duplex.from({readable:child.stdout,writable:child.stdin}), {onRequest:()=>({}), timeoutMs:15000})
  try {
    await peer.call('initialize', {protocolVersion:1,clientCapabilities:{}})
    const { sessionId } = await peer.call('session/new', {cwd:root,mcpServers:[]})
    const snapshot = await peer.call('pac/background_tasks/snapshot', {sessionId})
    assert.equal(snapshot.rootSessionId, sessionId)
    assert.equal(snapshot.availability, 'unknown')
    assert.match(snapshot.epoch, /^[0-9a-f-]{36}$/)
    assert.equal(Object.hasOwn(snapshot, 'tasks'), false)
    assert.deepEqual(await peer.call('pac/background_tasks/snapshot', {sessionId}), snapshot)
  } finally {
    peer.close()
    try { stopContained(child); await Promise.race([closed, new Promise((_, reject) => { const timer=setTimeout(() => reject(new Error('Router child did not close')), 15000); timer.unref() })]) }
    finally { await rm(root, {recursive:true,force:true,maxRetries:5,retryDelay:200}) }
  }
})

test('router invalidates its source epoch on connection loss', { skip: process.platform !== 'linux', timeout: 90000 }, async () => {
  const { createServer } = await import('node:http')
  const { writeFile } = await import('node:fs/promises')
  const { attachAcpRelay } = await import('../src/acp-relay.mjs')
  const { startAgent } = await import('../src/acp-transport.mjs')
  const root = await mkdtemp(join(tmpdir(), 'pac-snapshot-disconnect-'))
  const http = createServer(), relay = attachAcpRelay(http, {authorize:()=>true})
  let agent, child, peer, closed
  const notifications=[]
  try {
    await new Promise(resolve => http.listen(0,'127.0.0.1',resolve))
    const url=`ws://127.0.0.1:${http.address().port}`
    const fake=fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))
    const router=fileURLToPath(new URL('../adapters/pac-opencode-router.mjs', import.meta.url))
    await writeFile(join(root,'token'),'synthetic-token')
    agent=await startAgent({url,name:'fixture',token:'synthetic-token',command:process.execPath,args:[fake,'--text-response']})
    const env={...process.env,PAC_EXPERIMENTAL:'1',PAC_TEST_SNAPSHOT_CHANNEL:'1',PAC_OPENCODE_BINARY:process.execPath,PAC_NAME:'fixture',PAC_RELAY_URL:url,PAC_SOURCE_TOKEN_FILE:join(root,'token'),PAC_CONTROLLER_CWD:root}
    delete env.PAC_ENDPOINTS_FILE
    child=spawnContained(process.execPath,[router,fake,'--native'],{cwd:root,env,stdio:['pipe','pipe','pipe'],windowsHide:true})
    child.on('error',()=>{});child.stderr.resume();closed=new Promise(resolve=>child.once('close',resolve))
    peer=createAcpPeer(Duplex.from({readable:child.stdout,writable:child.stdin}),{onRequest:()=>({}),onNotification:(method,params)=>notifications.push({method,params}),timeoutMs:20000})
    await peer.call('initialize',{protocolVersion:1,clientCapabilities:{}})
    const {sessionId}=await peer.call('session/new',{cwd:root,mcpServers:[]})
    await peer.call('session/set_config_option',{sessionId,configId:'model',value:'PAC_fixture/sonnet'})
    const state=await peer.call('pac/background_tasks/snapshot',{sessionId})
    assert.equal(state.availability,'unknown')
    agent.close(); relay.close()
    const deadline=Date.now()+15000
    while (!notifications.some(event=>event.method==='pac/background_availability')) { if(Date.now()>deadline) throw new Error('No disconnect invalidation'); await new Promise(resolve=>setTimeout(resolve,50)) }
    assert.deepEqual(notifications.find(event=>event.method==='pac/background_availability').params,{rootSessionId:sessionId,epoch:state.epoch,availability:'unknown'})
  } finally {
    peer?.close(); agent?.close(); relay.close(); http.closeAllConnections(); await new Promise(resolve=>http.close(resolve))
    if(child) { stopContained(child); await Promise.race([closed,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Router did not close')),15000);timer.unref()})]) }
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:200})
  }
})


test('a source terminal start invalidates the bound epoch before its outcome', { skip: process.platform !== 'linux', timeout: 90000 }, async () => {
  const { createServer } = await import('node:http')
  const { writeFile } = await import('node:fs/promises')
  const { attachAcpRelay } = await import('../src/acp-relay.mjs')
  const { startAgent } = await import('../src/acp-transport.mjs')
  const root = await mkdtemp(join(tmpdir(), 'pac-snapshot-terminal-'))
  const http = createServer(), relay = attachAcpRelay(http, { authorize: () => true })
  let agent, child, peer, closed
  const notifications = []
  let disconnectStarted = false
  try {
    await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
    const url = `ws://127.0.0.1:${http.address().port}`
    const fake = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))
    const source = fileURLToPath(new URL('./fixtures/fake-snapshot-terminal.mjs', import.meta.url))
    const router = fileURLToPath(new URL('../adapters/pac-opencode-router.mjs', import.meta.url))
    await writeFile(join(root, 'token'), 'synthetic-token')
    agent = await startAgent({ url, name: 'fixture', token: 'synthetic-token', command: process.execPath, args: [source] })
    const env = { ...process.env, PAC_EXPERIMENTAL:'1', PAC_TEST_SNAPSHOT_CHANNEL:'1', PAC_OPENCODE_BINARY:process.execPath, PAC_NAME:'fixture', PAC_RELAY_URL:url, PAC_SOURCE_TOKEN_FILE:join(root,'token'), PAC_CONTROLLER_CWD:root, PAC_SOURCE_BASH:join(root,'missing-bash') }
    delete env.PAC_ENDPOINTS_FILE
    child = spawnContained(process.execPath, [router, fake, '--native'], { cwd:root, env, stdio:['pipe','pipe','pipe'], windowsHide:true })
    child.on('error', () => {}); child.stderr.resume(); closed = new Promise(resolve => child.once('close', resolve))
    peer = createAcpPeer(Duplex.from({ readable:child.stdout, writable:child.stdin }), { onRequest:()=>({}), onNotification:(method,params)=>{
      notifications.push({method,params})
      if (method === 'pac/background_availability' && !disconnectStarted) { disconnectStarted = true; agent.close(); relay.close() }
    }, timeoutMs:20000 })
    await peer.call('initialize', { protocolVersion:1, clientCapabilities:{} })
    const { sessionId } = await peer.call('session/new', { cwd:root, mcpServers:[] })
    await peer.call('session/set_config_option', { sessionId, configId:'model', value:'PAC_fixture/sonnet' })
    const state = await peer.call('pac/background_tasks/snapshot', { sessionId })
    try { await peer.call('session/prompt', { sessionId, prompt:[{ type:'text', text:'synthetic' }] }) } catch (error) { assert.match(error.message, /disconnect|lost|unknown/i) }
    await peer.drainNotifications()
    assert.ok(notifications.some(event => event.method === 'pac/background_availability' && event.params.rootSessionId === sessionId && event.params.epoch === state.epoch && event.params.availability === 'unknown'))
    assert.equal(disconnectStarted, true)
    assert.equal((await peer.call('pac/background_tasks/snapshot', { sessionId })).availability, 'unknown')
  } finally {
    peer?.close(); agent?.close(); relay.close(); http.closeAllConnections(); await new Promise(resolve => http.close(resolve))
    if (child) { stopContained(child); await Promise.race([closed, new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Router did not close')),15000);timer.unref()})]) }
    await rm(root, { recursive:true, force:true, maxRetries:5, retryDelay:200 })
  }
})

test('a broken parent output pipe shuts down the test-only router', { skip: process.platform !== 'linux', timeout: 90000 }, async () => {
  const { createServer } = await import('node:http')
  const { writeFile } = await import('node:fs/promises')
  const { attachAcpRelay } = await import('../src/acp-relay.mjs')
  const { startAgent } = await import('../src/acp-transport.mjs')
  const root = await mkdtemp(join(tmpdir(), 'pac-snapshot-output-'))
  const http = createServer(), relay = attachAcpRelay(http, { authorize:()=>true })
  let agent, child, peer, closed
  try {
    await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
    const url = `ws://127.0.0.1:${http.address().port}`
    const fake = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))
    const source = fileURLToPath(new URL('./fixtures/fake-snapshot-terminal.mjs', import.meta.url))
    const router = fileURLToPath(new URL('../adapters/pac-opencode-router.mjs', import.meta.url))
    await writeFile(join(root,'token'),'synthetic-token')
    agent = await startAgent({ url, name:'fixture', token:'synthetic-token', command:process.execPath, args:[source] })
    const env = { ...process.env, PAC_EXPERIMENTAL:'1', PAC_TEST_SNAPSHOT_CHANNEL:'1', PAC_OPENCODE_BINARY:process.execPath, PAC_NAME:'fixture', PAC_RELAY_URL:url, PAC_SOURCE_TOKEN_FILE:join(root,'token'), PAC_CONTROLLER_CWD:root, PAC_SOURCE_BASH:join(root,'missing-bash') }
    delete env.PAC_ENDPOINTS_FILE
    child = spawnContained(process.execPath, [router,fake,'--native'], { cwd:root, env, stdio:['pipe','pipe','pipe'], windowsHide:true })
    child.on('error',()=>{}); child.stderr.resume(); child.stdin.on('error',()=>{}); closed = new Promise(resolve=>child.once('close',resolve))
    peer = createAcpPeer(Duplex.from({readable:child.stdout,writable:child.stdin}), { onRequest:()=>({}), timeoutMs:20000 })
    await peer.call('initialize',{protocolVersion:1,clientCapabilities:{}})
    const {sessionId} = await peer.call('session/new',{cwd:root,mcpServers:[]})
    await peer.call('session/set_config_option',{sessionId,configId:'model',value:'PAC_fixture/sonnet'})
    child.stdout.destroy()
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:'broken-output',method:'session/prompt',params:{sessionId,prompt:[{type:'text',text:'synthetic'}]}})+'\n')
    await Promise.race([closed, new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Router did not shut down after output failure')),15000);timer.unref()})])
  } finally {
    peer?.close(); agent?.close(); relay.close(); http.closeAllConnections(); await new Promise(resolve=>http.close(resolve))
    if(child) { stopContained(child); await Promise.race([closed,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Router did not close')),15000);timer.unref()})]) }
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:200})
  }
})
