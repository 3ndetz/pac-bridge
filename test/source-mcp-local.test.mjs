import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openLocalSourceMcp, ContainedTransport } from '../src/source-mcp-local.mjs'
import { EventEmitter } from 'node:events'

const fixture = fileURLToPath(new URL('./fixtures/mock-source-mcp.mjs', import.meta.url))
const config = { type: 'local', enabled: true, command: [process.execPath, fixture] }
const safety = { verifyProvenance: async () => true, approveStart: async () => true }
const failureFixture = fileURLToPath(new URL('./fixtures/source-mcp-failure.mjs', import.meta.url))
const failureConfig = mode => ({ type: 'local', enabled: true, command: [process.execPath, failureFixture], environment: { TEST_MODE: mode } })

test('local source tools require each approval and update their catalog', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-source-mcp-'))
  let client, changed
  try {
    await writeFile(join(root, 'mcp-fixture.txt'), 'source-only')
    let approvals = 0
    const notification = new Promise(resolve => { changed = resolve })
    client = await openLocalSourceMcp({ config, cwd: root, ...safety, authorize: async () => ++approvals === 1, onChanged: changed })
    assert.deepEqual((await client.list()).tools.map(tool => tool.name), ['read_source_marker'])
    const result = await client.call('read_source_marker', {}, { session: 'fixture' })
    assert.equal(result.content[0].text, 'source-only')
    await notification
    await assert.rejects(client.call('read_source_marker', {}, {}), /unavailable/)
    assert.deepEqual((await client.list()).tools.map(tool => tool.name), ['read_source_marker', 'dynamic_marker'])
    await assert.rejects(client.call('dynamic_marker', {}, {}), /permission denied/)
    assert.equal(approvals, 2)
  } finally { await client?.close(); await rm(root, { recursive: true, force: true }) }
})

test('unsupported transport, expansion and unknown configuration fail closed', async () => {
  for (const invalid of [{ type: 'remote', url: 'https://example.invalid' }, { ...config, extra: true }, { ...config, environment: { TOKEN: '{env:SECRET}' } }, { ...config, enabled: false }]) {
    await assert.rejects(openLocalSourceMcp({ config: invalid, cwd: tmpdir(), ...safety, authorize: async () => true }), /Unsupported/)
  }
})

test('closing during approval prevents invocation', { timeout: 15000 }, async () => {
  let approve
  const client = await openLocalSourceMcp({ config, cwd: tmpdir(), ...safety, authorize: () => new Promise(resolve => { approve = resolve }) })
  await client.list()
  const call = client.call('read_source_marker', {}, {})
  const rejected = assert.rejects(call, /cancelled/)
  await client.close()
  approve(true)
  await rejected
  await client.close()
})

test('provenance and startup policy are mandatory before spawning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-mcp-policy-'))
  const marker = join(root, 'executed')
  const unsafe = { type: 'local', enabled: true, command: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`] }
  try {
    for (const options of [{ ...safety, verifyProvenance: async () => false }, { ...safety, approveStart: async () => false }, {}]) {
      await assert.rejects(openLocalSourceMcp({ config: unsafe, cwd: root, ...options, authorize: async () => true }), /Unsupported|not authorized/)
    }
    await assert.rejects(access(marker), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('malformed and oversized output and a stalled startup close their owned process', { timeout: 90000 }, async () => {
  for (const mode of ['malformed', 'oversized', 'startup-hang']) {
    await assert.rejects(openLocalSourceMcp({ config: failureConfig(mode), cwd: tmpdir(), ...safety, authorize: async () => true, timeoutMs: 2500, startupTimeoutMs: 6000 }), /connection failed/)
  }
})

test('disconnect or timeout during discovery and calls fails closed', { timeout: 120000 }, async () => {
  for (const mode of ['list-hang', 'list-disconnect', 'call-disconnect', 'call-hang']) {
    const client = await openLocalSourceMcp({ config: failureConfig(mode), cwd: tmpdir(), ...safety, authorize: async () => true, timeoutMs: 2500 })
    try {
      if (mode.startsWith('list')) await assert.rejects(client.list(), /discovery failed/)
      else { await client.list(); await assert.rejects(client.call('test', {}, {}), /call failed/) }
      await client.close()
      await client.close()
    } finally { await client.close() }
  }
})

test('disconnect releases an approval that never resolves', { timeout: 30000 }, async () => {
  const client = await openLocalSourceMcp({ config: failureConfig('approval-disconnect'), cwd: tmpdir(), ...safety, authorize: () => new Promise(() => {}), timeoutMs: 2500 })
  try { await client.list(); await assert.rejects(client.call('test', {}, {}), /cancelled/) } finally { await client.close() }
})

test('abort releases a pending approval without calling the tool', { timeout: 30000 }, async () => {
  const client = await openLocalSourceMcp({ config: failureConfig('normal'), cwd: tmpdir(), ...safety, authorize: () => new Promise(() => {}) })
  const cancellation = new AbortController()
  try {
    await client.list()
    const rejected = assert.rejects(client.call('test', {}, {}, { signal: cancellation.signal }), /cancelled/)
    cancellation.abort()
    await rejected
  } finally { await client.close() }
})

test('blocked stdin write times out and closes the owned process', { timeout: 30000 }, async () => {
  const client = await openLocalSourceMcp({ config: failureConfig('backpressure'), cwd: tmpdir(), ...safety, authorize: async () => true, timeoutMs: 2500 })
  try { await client.list(); await assert.rejects(client.call('test', { data: 'x'.repeat(8 * 1024 * 1024) }, {}), /call failed/) } finally { await client.close(); await client.close() }
})

test('failed owned-process cleanup is reported consistently on repeated close', async () => {
  const transport = new ContainedTransport({}, tmpdir(), {}, 100, () => { throw new Error('stop failed') }, 50)
  transport.child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null })
  await assert.rejects(transport.close(), /stop failed/)
  await assert.rejects(transport.close(), /stop failed/)
})

test('a failed stop request is accepted only after the owned child closes', async () => {
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null })
  const transport = new ContainedTransport({}, tmpdir(), {}, 100, () => {
    queueMicrotask(() => child.emit('close'))
    throw new Error('stop request failed')
  }, 100)
  transport.child = child
  await transport.close()
  await transport.close()
})

test('an exited child still requires its close event before cleanup succeeds', async () => {
  const child = Object.assign(new EventEmitter(), { exitCode: 0, signalCode: null })
  let stops = 0, release
  const transport = new ContainedTransport({}, tmpdir(), {}, 100, () => { stops++ }, 100)
  transport.child = child
  transport.closed = new Promise(resolve => { release = resolve })
  let finished = false
  const closing = transport.close().then(() => { finished = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(finished, false)
  assert.equal(stops, 0)
  release()
  await closing
  assert.equal(finished, true)
})

test('an exited child with unconfirmed close reports cleanup failure', async () => {
  const transport = new ContainedTransport({}, tmpdir(), {}, 100, () => {}, 20)
  transport.child = Object.assign(new EventEmitter(), { exitCode: 0, signalCode: null })
  transport.closed = new Promise(() => {})
  await assert.rejects(transport.close(), /timed out/)
  await assert.rejects(transport.close(), /timed out/)
})

test('a stalled transport write is bounded and terminates its child', async () => {
  let stops = 0
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, stdin: { writable: true, write() {} } })
  const transport = new ContainedTransport({}, tmpdir(), {}, 50, () => { stops++; child.emit('close') }, 100)
  transport.child = child
  await assert.rejects(transport.send({ jsonrpc: '2.0', method: 'test' }), /timed out/)
  await transport.close()
  assert.equal(stops, 1)
})

test('two sessions keep approval, results and lifetime isolated', { timeout: 30000 }, async () => {
  const rootA = await mkdtemp(join(tmpdir(), 'pac-mcp-a-'))
  const rootB = await mkdtemp(join(tmpdir(), 'pac-mcp-b-'))
  let a, b, allowedB = false
  try {
    await Promise.all([writeFile(join(rootA, 'mcp-fixture.txt'), 'only-a'), writeFile(join(rootB, 'mcp-fixture.txt'), 'only-b')])
    ;[a, b] = await Promise.all([
      openLocalSourceMcp({ config, cwd: rootA, ...safety, authorize: async ({ context }) => context === 'a' }),
      openLocalSourceMcp({ config, cwd: rootB, ...safety, authorize: async ({ context }) => context === 'b' && allowedB })
    ])
    await Promise.all([a.list(), b.list()])
    await assert.rejects(b.call('read_source_marker', {}, 'a'), /denied/)
    assert.equal((await a.call('read_source_marker', {}, 'a')).content[0].text, 'only-a')
    await a.close()
    allowedB = true
    assert.equal((await b.call('read_source_marker', {}, 'b')).content[0].text, 'only-b')
    await assert.rejects(a.call('read_source_marker', {}, 'a'), /unavailable/)
  } finally {
    await Promise.all([a?.close(), b?.close()])
    await Promise.all([rm(rootA, { recursive: true, force: true }), rm(rootB, { recursive: true, force: true })])
  }
})
