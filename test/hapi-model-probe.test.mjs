import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { Duplex, PassThrough } from 'node:stream'
import test from 'node:test'
import { createAcpPeer } from '../src/acp-peer.mjs'
import { mergeProbeModels, nativeModels, startHapiModelProbe } from '../src/hapi-model-probe.mjs'

test('shares the native model probe deadline between initialize and session creation', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-native-deadline-'))
  try {
    await writeFile(join(root, 'acp'), `const r=require('node:readline').createInterface({input:process.stdin});r.on('line',line=>{const x=JSON.parse(line);setTimeout(()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:x.id,result:x.method==='initialize'?{protocolVersion:1}:{sessionId:'native'}})+'\\n'),100)})`)
    const options = { binary: process.execPath, cwd: root, init: { protocolVersion: 1 }, params: { cwd: root, mcpServers: [] }, env: process.env }
    assert.equal((await nativeModels({ ...options, timeoutMs: 3000 })).sessionId, 'native')
    await assert.rejects(nativeModels({ ...options, timeoutMs: 150 }), /timed out/)
  } finally {
    const actual = await realpath(root), local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-native-deadline-')) await rm(actual, { recursive: true, force: true })
  }
})

test('merges PAC models without hiding native providers or duplicating IDs', () => {
  const result = mergeProbeModels({ sessionId: 'native', models: { currentModelId: 'native/model', availableModels: [{ modelId: 'native/model' }] },
    configOptions: [{ id: 'model', category: 'model', options: [{ value: 'native/model' }] }] },
  { models: [{ id: 'PAC_one/sonnet', name: 'PAC #1 / Claude Sonnet' }, { id: 'PAC_one/sonnet', name: 'duplicate' }], warnings: [] })
  assert.deepEqual(result.models.availableModels.map((item) => item.modelId), ['native/model', 'PAC_one/sonnet'])
  assert.deepEqual(result.configOptions[0].options.map((item) => item.value), ['native/model', 'PAC_one/sonnet'])
  assert.equal(result.models.currentModelId, 'native/model')
  const fromOptions = mergeProbeModels({ configOptions: [{ id: 'model', category: 'model', options: [{ value: 'native/option', name: 'Native' }] }] },
    { models: [{ id: 'PAC_one/sonnet', name: 'PAC' }], warnings: [] })
  assert.deepEqual(fromOptions.models.availableModels.map((item) => item.modelId), ['native/option', 'PAC_one/sonnet'])
})

test('uses the requested project directory for native and PAC model discovery', async () => {
  const toServer = new PassThrough(), toClient = new PassThrough(), cwd = tmpdir(), seen = []
  const server = startHapiModelProbe({ input: toServer, output: toClient, binary: process.execPath, env: { PAC_NAMED_PROVIDERS_EXPERIMENT: '1' },
    native: async ({ cwd: path }) => { seen.push(['native', path]); return { sessionId: 'native', models: { availableModels: [{ modelId: 'native/model' }] } } },
    discover: async ({ cwd: path }) => { seen.push(['pac', path]); return { models: [{ id: 'PAC_test/sonnet', name: 'PAC #1 / Claude Sonnet' }], warnings: [] } },
  })
  const client = createAcpPeer(Duplex.from({ readable: toClient, writable: toServer }))
  try {
    assert.equal((await client.call('initialize', { protocolVersion: 1, clientInfo: { name: 'hapi-opencode-models' } })).protocolVersion, 1)
    const result = await client.call('session/new', { cwd, mcpServers: [] })
    assert.deepEqual(seen, [['native', cwd], ['pac', cwd]])
    assert.ok(result.models.availableModels.some((model) => model.modelId === 'native/model'))
    assert.ok(result.models.availableModels.some((model) => model.modelId === 'PAC_test/sonnet'))
    await assert.rejects(client.call('session/new', { cwd, mcpServers: [] }), /Unsupported HAPI model probe/)
  } finally { client.close(); server.close() }
})

test('uses the legacy provider ID when named providers are disabled', async () => {
  const input = new PassThrough(), output = new PassThrough()
  const server = startHapiModelProbe({ input, output, binary: process.execPath, env: {},
    native: async () => ({ sessionId: 'native', models: { availableModels: [] } }),
    discover: async () => ({ models: [{ id: 'PAC_test/sonnet', name: 'PAC' }], warnings: [] }) })
  const client = createAcpPeer(Duplex.from({ readable: output, writable: input }))
  try {
    await client.call('initialize', { protocolVersion: 1, clientInfo: { name: 'hapi-opencode-models' } })
    const result = await client.call('session/new', { cwd: tmpdir(), mcpServers: [] })
    assert.equal(result.models.availableModels[0].modelId, 'pacbridge/PAC_test/sonnet')
  } finally { client.close(); server.close() }
})

test('keeps native models when the PAC configuration cannot be read', async () => {
  const input = new PassThrough(), output = new PassThrough()
  const server = startHapiModelProbe({ input, output, binary: process.execPath, env: {},
    native: async () => ({ sessionId: 'native', models: { availableModels: [{ modelId: 'native/model' }] } }),
    discover: async () => { throw new Error('private configuration details') } })
  const client = createAcpPeer(Duplex.from({ readable: output, writable: input }))
  try {
    await client.call('initialize', { protocolVersion: 1, clientInfo: { name: 'hapi-opencode-models' } })
    const result = await client.call('session/new', { cwd: tmpdir(), mcpServers: [] })
    assert.deepEqual(result.models.availableModels, [{ modelId: 'native/model' }])
    assert.deepEqual(result._meta.pacDiscoveryWarnings, [{ name: 'configuration', code: 'unavailable' }])
  } finally { client.close(); server.close() }
})

test('retries a fast unavailable PAC once without losing native models', async () => {
  const input = new PassThrough(), output = new PassThrough()
  let calls = 0
  const server = startHapiModelProbe({ input, output, binary: process.execPath, env: { PAC_NAMED_PROVIDERS_EXPERIMENT: '1' },
    native: async () => ({ sessionId: 'native', models: { availableModels: [{ modelId: 'native/model' }] } }),
    discover: async () => ++calls === 1 ? { models: [], warnings: [{ name: 'testpac', code: 'unavailable' }] }
      : { models: [{ id: 'PAC_testpac/sonnet', name: 'PAC' }], warnings: [] } })
  const client = createAcpPeer(Duplex.from({ readable: output, writable: input }))
  try {
    await client.call('initialize', { protocolVersion: 1, clientInfo: { name: 'hapi-opencode-models' } })
    const result = await client.call('session/new', { cwd: tmpdir(), mcpServers: [] })
    assert.equal(calls, 2)
    assert.deepEqual(result.models.availableModels.map(item => item.modelId), ['native/model', 'PAC_testpac/sonnet'])
    assert.equal(result._meta?.pacDiscoveryWarnings, undefined)
  } finally { client.close(); server.close() }
})

test('does not retry rejected source policy', async () => {
  const input = new PassThrough(), output = new PassThrough()
  let calls = 0
  const server = startHapiModelProbe({ input, output, binary: process.execPath, env: {},
    native: async () => ({ sessionId: 'native', models: { availableModels: [] } }),
    discover: async () => { calls++; return { models: [], warnings: [{ name: 'testpac', code: 'source_setup_failed' }] } } })
  const client = createAcpPeer(Duplex.from({ readable: output, writable: input }))
  try {
    await client.call('initialize', { protocolVersion: 1, clientInfo: { name: 'hapi-opencode-models' } })
    const result = await client.call('session/new', { cwd: tmpdir(), mcpServers: [] })
    assert.equal(calls, 1)
    assert.deepEqual(result._meta.pacDiscoveryWarnings, [{ name: 'testpac', code: 'source_setup_failed' }])
  } finally { client.close(); server.close() }
})
