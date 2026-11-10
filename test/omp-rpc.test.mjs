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
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-8192) })
  child.stdin.on('error', () => {})
  const lines = createInterface({ input: child.stdout })
  function request(payload) {
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); lines.off('line', onLine); child.off('error', onError); child.off('exit', onExit) }
      const onError = (error) => { cleanup(); reject(error) }
      const onExit = (code) => onError(new Error(`OMP RPC exited (code ${code}; flags: ${['no model', 'no models', 'api key', 'authentication', 'configured', 'tty'].filter((word) => stderr.toLowerCase().includes(word)).join(',')})`))
      const onLine = (line) => {
        try { const item = JSON.parse(line); if (item.id === payload.id) { cleanup(); resolve(item) } }
        catch { onError(new Error('OMP RPC emitted invalid JSON')) }
      }
      const timer = setTimeout(() => onError(new Error('OMP RPC request timed out')), 10000)
      lines.on('line', onLine)
      child.once('error', onError)
      child.once('exit', onExit)
      child.stdin.write(JSON.stringify(payload) + '\n')
    })
  }
  try {
    const event = await request({ id: 'probe-state', type: 'get_state' })
    assert.equal(event.type, 'response')
    assert.equal(event.command, 'get_state')
    assert.equal(event.success, true)
    assert.ok(event.data && typeof event.data === 'object')
    assert.ok(event.data.model && typeof event.data.model === 'object')
    assert.equal(event.data.model.provider, 'openai')
    assert.equal(event.data.model.id, 'gpt-4o-mini')
    const models = await request({ id: 'probe-models', type: 'get_available_models' })
    assert.equal(models.type, 'response')
    assert.equal(models.command, 'get_available_models')
    assert.equal(models.success, true)
    assert.ok(Array.isArray(models.data?.models))
    assert.ok(models.data.models.some((model) => model.provider === 'openai' && model.id === 'gpt-4o-mini'))
    assert.ok(models.data.models.some((model) => model.provider === 'openai' && model.id === 'gpt-4.1-mini'))
    const switched = await request({ id: 'probe-switch', type: 'set_model', provider: 'openai', modelId: 'gpt-4.1-mini' })
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
