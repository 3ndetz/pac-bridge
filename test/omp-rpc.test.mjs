import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { spawnContained, stopContained } from '../src/spawn-contained.mjs'

test('obtains OMP RPC state and changes models without invoking a model', { skip: !process.env.PAC_OMP_BIN, timeout: 45000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-omp-rpc-'))
  const child = spawnContained(process.env.PAC_OMP_BIN, ['--mode', 'rpc', '--no-session', '--model', 'openai/gpt-4o-mini'], {
    cwd: root, env: { ...process.env, OPENAI_API_KEY: 'pac-test-placeholder' }, stdio: ['pipe', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
  const lines = createInterface({ input: child.stdout })
  try {
    const response = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code) => reject(new Error(`OMP RPC exited before responding (code ${code}; flags: ${['no model', 'no models', 'api key', 'authentication', 'configured', 'tty'].filter((word) => stderr.toLowerCase().includes(word)).join(',')})`)))
      lines.on('line', (line) => {
        try { const event = JSON.parse(line); if (event.id === 'probe-state') resolve(event) } catch { reject(new Error('OMP RPC emitted invalid JSON')) }
      })
    })
    child.stdin.write(JSON.stringify({ id: 'probe-state', type: 'get_state' }) + '\n')
    const event = await response
    assert.equal(event.type, 'response')
    assert.equal(event.command, 'get_state')
    assert.equal(event.success, true)
    assert.ok(event.data && typeof event.data === 'object')
    assert.ok(event.data.model && typeof event.data.model === 'object')
    assert.equal(event.data.model.provider, 'openai')
    assert.equal(event.data.model.id, 'gpt-4o-mini')
    const modelsResponse = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', () => reject(new Error('OMP RPC exited before listing models')))
      lines.on('line', (line) => {
        try { const item = JSON.parse(line); if (item.id === 'probe-models') resolve(item) } catch { reject(new Error('OMP RPC emitted invalid JSON')) }
      })
    })
    child.stdin.write(JSON.stringify({ id: 'probe-models', type: 'get_available_models' }) + '\n')
    const models = await modelsResponse
    assert.equal(models.type, 'response')
    assert.equal(models.command, 'get_available_models')
    assert.equal(models.success, true)
    assert.ok(Array.isArray(models.data?.models))
    assert.ok(models.data.models.some((model) => model.provider === 'openai' && model.id === 'gpt-4o-mini'))
    assert.ok(models.data.models.some((model) => model.provider === 'openai' && model.id === 'gpt-4.1-mini'))
    const switchResponse = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', () => reject(new Error('OMP RPC exited before switching models')))
      lines.on('line', (line) => {
        try { const item = JSON.parse(line); if (item.id === 'probe-switch') resolve(item) } catch { reject(new Error('OMP RPC emitted invalid JSON')) }
      })
    })
    child.stdin.write(JSON.stringify({ id: 'probe-switch', type: 'set_model', provider: 'openai', modelId: 'gpt-4.1-mini' }) + '\n')
    const switched = await switchResponse
    assert.equal(switched.type, 'response')
    assert.equal(switched.command, 'set_model')
    assert.equal(switched.success, true)
    assert.equal(switched.data?.id, 'gpt-4.1-mini')
  } finally {
    const exited = child.exitCode === null ? once(child, 'close') : Promise.resolve()
    lines.close()
    stopContained(child)
    await exited
    const actual = await realpath(root)
    const local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-omp-rpc-')) await rm(actual, { recursive: true, force: true })
  }
})
