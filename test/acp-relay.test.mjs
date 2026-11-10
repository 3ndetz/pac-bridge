import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { WebSocket } from 'ws'
import { attachAcpRelay } from '../src/acp-relay.mjs'
import { connectSource, startAgent } from '../src/acp-transport.mjs'
import { startSupervisedAgent } from '../src/supervised-agent.mjs'
import { createAcpPeer } from '../src/acp-peer.mjs'

async function setup(options = {}, port = 0) {
  const server = createServer()
  const relay = attachAcpRelay(server, { ...options, authorize: options.authorize || (({ role, token }) => token === (role === 'source' ? 'source-secret' : 'agent-secret')) })
  let registrationSocket
  server.on('upgrade', (request, socket) => { if (request.url === '/acp-relay/register') registrationSocket = socket })
  server.listen(port, '127.0.0.1')
  await once(server, 'listening')
  const base = `ws://127.0.0.1:${server.address().port}/acp-relay/`
  const connect = (role, name = 'pac-one', channel, token = role === 'source' ? 'source-secret' : 'agent-secret') =>
    new WebSocket(base + role, { headers: { authorization: `Bearer ${token}`, 'x-pac-name': name, ...(channel ? { 'x-pac-channel': channel } : {}) } })
  return { connect, url: base.replace(/\/acp-relay\/$/, ''), closeRegistration: () => registrationSocket?.destroy(), close: () => { relay.close(); server.close() } }
}

test('relays MCP tool results and dynamic catalog notifications without rewriting', { timeout: 30000 }, async () => {
  const hub = await setup()
  const workspace = await mkdtemp(join(tmpdir(), 'pac-mcp-test-'))
  let agent
  let peer
  try {
    await writeFile(join(workspace, 'mcp-fixture.txt'), 'SOURCE_ONLY_MARKER')
    agent = await startAgent({ url: hub.url, name: 'pac-one', token: 'agent-secret', command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/mock-source-mcp.mjs', import.meta.url))], cwd: workspace })
    const notifications = []
    peer = createAcpPeer(await connectSource({ url: hub.url, name: 'pac-one', token: 'source-secret' }),
      { onNotification: (method) => notifications.push(method) })
    const initialized = await peer.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    assert.equal(initialized.capabilities.tools.listChanged, true)
    assert.deepEqual((await peer.call('tools/list', {})).tools.map((item) => item.name), ['read_source_marker'])
    assert.equal((await peer.call('tools/call', { name: 'read_source_marker', arguments: {} })).content[0].text, 'SOURCE_ONLY_MARKER')
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(notifications, ['notifications/tools/list_changed'])
    assert.deepEqual((await peer.call('tools/list', {})).tools.map((item) => item.name), ['read_source_marker', 'dynamic_marker'])
    assert.equal((await peer.call('tools/call', { name: 'dynamic_marker', arguments: {} })).content[0].text, 'PAC_DYNAMIC_MCP_RESULT')
  } finally {
    peer?.close()
    agent?.close()
    hub.close()
    const actual = await realpath(workspace)
    const local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-mcp-test-')) await rm(actual, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('closes established channels when their PAC registration disconnects', { timeout: 10000 }, async () => {
  const hub = await setup()
  try {
    const registration = hub.connect('register')
    const otherRegistration = hub.connect('register', 'pac-two')
    await Promise.all([once(registration, 'open'), once(otherRegistration, 'open')])
    const connectPair = async (name, owner) => {
      const request = once(owner, 'message')
      const source = hub.connect('source', name)
      await once(source, 'open')
      const [message] = await request
      const agent = hub.connect('agent', name, JSON.parse(message.toString()).channel)
      await once(agent, 'open')
      agent.send('ready')
      const echo = once(source, 'message')
      agent.send('connected')
      assert.equal((await echo)[0].toString(), 'connected')
      return { source, agent }
    }
    const first = await connectPair('pac-one', registration)
    const second = await connectPair('pac-two', otherRegistration)
    const closed = [once(first.source, 'close'), once(first.agent, 'close')]
    registration.close()
    await Promise.all(closed)
    const message = once(second.source, 'message')
    second.agent.send('still connected')
    assert.equal((await message)[0].toString(), 'still connected')
  } finally { hub.close() }
})

test('limits pending source connections and releases capacity on disconnect', { timeout: 10000 }, async () => {
  const hub = await setup({ maxPending: 1 })
  try {
    const registration = hub.connect('register')
    await once(registration, 'open')
    const firstOpen = once(registration, 'message')
    const first = hub.connect('source')
    await once(first, 'open')
    await firstOpen
    const rejected = hub.connect('source')
    const status = await new Promise((resolve, reject) => {
      rejected.on('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode) })
      rejected.on('open', () => reject(new Error('Unexpected connection')))
      rejected.on('error', reject)
    })
    assert.equal(status, 503)
    const closed = once(first, 'close')
    first.close()
    await closed
    const nextOpen = once(registration, 'message')
    let connected = false
    for (let attempt = 0; attempt < 50 && !connected; attempt++) {
      const next = hub.connect('source')
      connected = await new Promise((resolve, reject) => {
        next.on('open', () => resolve(true))
        next.on('unexpected-response', (_request, response) => { response.resume(); response.statusCode === 503 ? resolve(false) : reject(new Error('Unexpected response')) })
        next.on('error', reject)
      })
      if (!connected) await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(connected, true)
    await nextOpen
  } finally { hub.close() }
})

test('relays independent bidirectional ACP streams, including early source data', { timeout: 10000 }, async () => {
  const hub = await setup()
  try {
    const registration = hub.connect('register')
    await once(registration, 'open')
    const firstOpen = once(registration, 'message')
    const first = hub.connect('source')
    await once(first, 'open')
    first.send('early')
    const [firstMessage] = await firstOpen
    const { channel: firstChannel } = JSON.parse(firstMessage.toString())
    const agent = hub.connect('agent', 'pac-one', firstChannel)
    const early = once(agent, 'message')
    await once(agent, 'open')
    agent.send('ready')
    assert.equal((await early)[0].toString(), 'early')
    const reply = once(first, 'message')
    agent.send('result')
    assert.equal((await reply)[0].toString(), 'result')
    const secondOpen = once(registration, 'message')
    const second = hub.connect('source')
    await once(second, 'open')
    const [message] = await secondOpen
    const secondAgent = hub.connect('agent', 'pac-one', JSON.parse(message.toString()).channel)
    await once(secondAgent, 'open')
    secondAgent.send('ready')
    const secondReply = once(second, 'message')
    secondAgent.send('second')
    assert.equal((await secondReply)[0].toString(), 'second')
    const disconnected = once(agent, 'close')
    first.close()
    await disconnected
    const stillConnected = once(second, 'message')
    secondAgent.send('still connected')
    assert.equal((await stillConnected)[0].toString(), 'still connected')
  } finally { hub.close() }
})

test('starts an agent process and carries ACP messages through the relay', { timeout: 10000 }, async () => {
  const hub = await setup()
  let agent
  let source
  try {
    agent = await startAgent({ url: hub.url, name: 'pac-one', token: 'agent-secret', command: process.execPath,
      args: ['-e', 'process.stdin.pipe(process.stdout)'] })
    source = await connectSource({ url: hub.url, name: 'pac-one', token: 'source-secret' })
    const message = once(source, 'data')
    source.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n')
    assert.equal((await message)[0].toString(), '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n')
  } finally { source?.destroy(); agent?.close(); hub.close() }
})

test('does not expose agent stderr in diagnostic callbacks', { timeout: 10000 }, async () => {
  const hub = await setup()
  let agent
  let source
  const diagnostics = []
  try {
    agent = await startAgent({ url: hub.url, name: 'pac-one', token: 'agent-secret', command: process.execPath,
      args: ['-e', 'process.stderr.write("PRIVATE_SENTINEL");process.stdin.pipe(process.stdout)'], onError: (error) => diagnostics.push(error.message) })
    source = await connectSource({ url: hub.url, name: 'pac-one', token: 'source-secret' })
    const message = once(source, 'data')
    source.write('ready')
    assert.equal((await message)[0].toString(), 'ready')
    const deadline = Date.now() + 3000
    while (!diagnostics.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.ok(diagnostics.some((value) => value.includes('suppressed')))
    assert.ok(diagnostics.every((value) => !value.includes('PRIVATE_SENTINEL')))
  } finally { source?.destroy(); agent?.close(); hub.close() }
})

test('closes active sessions when the agent registration connection is lost', { timeout: 10000 }, async () => {
  const hub = await setup()
  let agent
  let source
  try {
    agent = await startAgent({ url: hub.url, name: 'pac-one', token: 'agent-secret', command: process.execPath,
      args: ['-e', 'process.stdin.pipe(process.stdout)'] })
    source = await connectSource({ url: hub.url, name: 'pac-one', token: 'source-secret' })
    const ready = once(source, 'data')
    source.write('ready')
    assert.equal((await ready)[0].toString(), 'ready')
    const closed = once(source, 'end')
    hub.closeRegistration()
    await closed
  } finally { source?.destroy(); agent?.close(); hub.close() }
})

test('supervisor reconnects registration without replaying the interrupted session', { timeout: 15000 }, async () => {
  const hub = await setup()
  let agent
  let source
  let replacement
  try {
    agent = await startSupervisedAgent({ url: hub.url, name: 'pac-one', token: 'agent-secret', command: process.execPath,
      args: ['-e', 'process.stdin.pipe(process.stdout)'], retryMs: 100 })
    source = await connectSource({ url: hub.url, name: 'pac-one', token: 'source-secret' })
    const first = once(source, 'data')
    source.write('first')
    assert.equal((await first)[0].toString(), 'first')
    const ended = once(source, 'end')
    hub.closeRegistration()
    await ended
    const deadline = Date.now() + 5000
    while (!replacement && Date.now() < deadline) {
      try { replacement = await connectSource({ url: hub.url, name: 'pac-one', token: 'source-secret' }) }
      catch { await new Promise((resolve) => setTimeout(resolve, 50)) }
    }
    assert.ok(replacement)
    const next = once(replacement, 'data')
    replacement.write('second')
    assert.equal((await next)[0].toString(), 'second')
    agent.close()
    await new Promise((resolve) => setTimeout(resolve, 500))
    await assert.rejects(connectSource({ url: hub.url, name: 'pac-one', token: 'source-secret' }))
  } finally { source?.destroy(); replacement?.destroy(); agent?.close(); hub.close() }
})

test('reports an uncertain in-flight result across supervisor reconnection', { timeout: 15000 }, async () => {
  const hub = await setup()
  const root = await mkdtemp(join(tmpdir(), 'pac-agent-'))
  let agent
  let source
  let replacement
  try {
    const script = `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);if(request.method==='slow')require('node:fs').appendFileSync('side-effects','x');process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'received'})+'\\n');setTimeout(()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:'done'})+'\\n'),request.method==='slow'?5000:0)})`
    agent = await startSupervisedAgent({ url: hub.url, name: 'pac-one', token: 'agent-secret', command: process.execPath, args: ['-e', script], retryMs: 100, cwd: root })
    source = await connectSource({ url: hub.url, name: 'pac-one', token: 'source-secret' })
    let received
    const notification = new Promise((resolve) => { received = resolve })
    const peer = createAcpPeer(source, { onNotification: (method) => { if (method === 'received') received() } })
    const pending = peer.call('slow', {})
    await notification
    hub.closeRegistration()
    await assert.rejects(pending, /outcome may be unknown/)
    const deadline = Date.now() + 5000
    while (!replacement && Date.now() < deadline) {
      try { replacement = await connectSource({ url: hub.url, name: 'pac-one', token: 'source-secret' }) }
      catch { await new Promise((resolve) => setTimeout(resolve, 50)) }
    }
    assert.ok(replacement)
    let notifications = 0
    const next = createAcpPeer(replacement, { onNotification: () => { notifications++ } })
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(notifications, 0)
    assert.equal(await readFile(join(root, 'side-effects'), 'utf8'), 'x')
    assert.equal(await next.call('fresh', {}), 'done')
    next.close()
  } finally {
    source?.destroy(); replacement?.destroy(); agent?.close(); hub.close()
    const actual = await realpath(root)
    const local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-agent-')) await rm(actual, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('supervisor reloads its credential before reconnecting', { timeout: 15000 }, async () => {
  let currentToken = 'first-secret'
  let reads = 0
  const hub = await setup({ authorize: ({ role, token }) => token === (role === 'source' ? 'source-secret' : currentToken) })
  let agent
  let source
  try {
    agent = await startSupervisedAgent({ url: hub.url, name: 'pac-one', tokenProvider: async () => { reads++; return currentToken },
      command: process.execPath, args: ['-e', 'process.stdin.pipe(process.stdout)'], retryMs: 100 })
    currentToken = 'second-secret'
    hub.closeRegistration()
    const deadline = Date.now() + 5000
    while ((!source || reads < 2) && Date.now() < deadline) {
      if (reads >= 2) {
        try { source = await connectSource({ url: hub.url, name: 'pac-one', token: 'source-secret' }) } catch {}
      }
      if (!source) await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.ok(source)
    assert.ok(reads >= 2)
    const message = once(source, 'data')
    source.write('reconnected')
    assert.equal((await message)[0].toString(), 'reconnected')
  } finally { source?.destroy(); agent?.close(); hub.close() }
})

test('supervisor registers after a relay becomes available', { timeout: 15000 }, async () => {
  const reservation = createServer().listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = reservation.address().port
  await new Promise((resolve) => reservation.close(resolve))
  let hub
  let agent
  let source
  try {
    agent = await startSupervisedAgent({ url: `ws://127.0.0.1:${port}`, name: 'pac-one', token: 'agent-secret',
      command: process.execPath, args: ['-e', 'process.stdin.pipe(process.stdout)'], retryMs: 100 })
    hub = await setup({}, port)
    const deadline = Date.now() + 5000
    while (!source && Date.now() < deadline) {
      try { source = await connectSource({ url: hub.url, name: 'pac-one', token: 'source-secret' }) }
      catch { await new Promise((resolve) => setTimeout(resolve, 50)) }
    }
    assert.ok(source)
    const message = once(source, 'data')
    source.write('available')
    assert.equal((await message)[0].toString(), 'available')
  } finally { source?.destroy(); agent?.close(); hub?.close() }
})

test('disconnecting an agent session terminates its descendant processes', { timeout: 15000 }, async () => {
  const hub = await setup()
  const root = await mkdtemp(join(tmpdir(), 'pac-agent-'))
  let agent
  let source
  try {
    const descendant = 'setTimeout(()=>require("node:fs").writeFileSync("late-result","unexpected"),5000)'
    const script = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});process.stdout.write('ready');setInterval(()=>{},1000)`
    agent = await startAgent({ url: hub.url, name: 'pac-one', token: 'agent-secret', command: process.execPath, args: ['-e', script], cwd: root })
    source = await connectSource({ url: hub.url, name: 'pac-one', token: 'source-secret' })
    assert.equal((await once(source, 'data'))[0].toString(), 'ready')
    source.destroy()
    await new Promise((resolve) => setTimeout(resolve, 6000))
    assert.equal(await access(join(root, 'late-result')).then(() => true, () => false), false)
  } finally {
    source?.destroy(); agent?.close(); hub.close()
    const actual = await realpath(root)
    const local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-agent-')) await rm(actual, { recursive: true, force: true })
  }
})

test('initializes a real OMP process through the relay', { timeout: 30000, skip: !process.env.PAC_OMP_BIN }, async () => {
  const hub = await setup()
  let agent
  let source
  try {
    agent = await startAgent({ url: hub.url, name: 'pac-one', token: 'agent-secret', command: process.env.PAC_OMP_BIN, args: ['acp'] })
    source = await connectSource({ url: hub.url, name: 'pac-one', token: 'source-secret' })
    const lines = createInterface({ input: source })
    const reply = once(lines, 'line')
    source.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } }) + '\n')
    const [line] = await reply
    const response = JSON.parse(line)
    assert.equal(response.id, 1)
    assert.equal(response.result.protocolVersion, 1)
    lines.close()
  } finally { source?.destroy(); agent?.close(); hub.close() }
})

test('rejects unauthorized sources, unavailable PACs and duplicate registration', { timeout: 10000 }, async () => {
  const hub = await setup()
  async function status(socket) {
    return await new Promise((resolve, reject) => {
      socket.on('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode) })
      socket.on('open', () => reject(new Error('Unexpected connection')))
      socket.on('error', reject)
    })
  }
  try {
    assert.equal(await status(hub.connect('source', 'pac-one', undefined, 'wrong')), 401)
    assert.equal(await status(hub.connect('source', 'missing')), 503)
    const registration = hub.connect('register')
    await once(registration, 'open')
    assert.equal(await status(hub.connect('register')), 409)
  } finally { hub.close() }
})
