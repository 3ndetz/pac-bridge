import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { mkdtemp, readdir, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnContained, stopContained, stopContainedAndWait } from '../src/spawn-contained.mjs'

test('Windows stop requests use the owned child only once while its exit is pending', { skip: process.platform !== 'win32' }, () => {
  let calls = 0
  const child = { pid: 123, exitCode: null, signalCode: null, kill() { calls++; return calls === 1 } }
  stopContained(child)
  stopContained(child)
  assert.equal(calls, 1)
  assert.equal(child.exitCode, null, 'accepted stop does not confirm process exit')
})

test('a refused Windows stop remains explicit and may be retried by its owner', { skip: process.platform !== 'win32' }, () => {
  let calls = 0
  const child = { pid: 123, exitCode: null, signalCode: null, kill() { return ++calls > 1 } }
  assert.throws(() => stopContained(child), /outcome is unknown/)
  stopContained(child)
  stopContained(child)
  assert.equal(calls, 2)
})


test('owned stop confirmation requires exit evidence rather than a timeout', async () => {
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null })
  await assert.rejects(stopContainedAndWait(child, 20), /exit is unconfirmed/)
  assert.equal(child.listenerCount('close'), 0)
  const confirmed = stopContainedAndWait(child, 1000)
  child.emit('close', 0)
  await confirmed
  assert.equal(child.listenerCount('close'), 0)
})

test('an already exited owned child needs no new termination request', async () => {
  const child = Object.assign(new EventEmitter(), { exitCode: 0, signalCode: null, kill() { assert.fail('exited child must not be signalled') } })
  await stopContainedAndWait(child, 100)
  assert.equal(child.listenerCount('close'), 0)
  assert.throws(() => stopContainedAndWait(child, 0), /deadline/)
})


test('Windows job host without a user profile does not write a PowerShell cache into its workspace', { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-job-no-cache-'))
  const env = { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH }
  const child = spawnContained(process.execPath, ['-e', "process.stdout.write(process.env.PSModuleAnalysisCachePath || 'missing')"], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', errors = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk })
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', code => code === 0 ? resolve() : reject(new Error('Synthetic host failed: ' + errors)))
    })
    assert.equal(output, 'NUL')
    assert.deepEqual(await readdir(root), [])
  } finally {
    await stopContainedAndWait(child, 3000)
    // Non-recursive cleanup refuses unexpected files instead of deleting them.
    await rmdir(root)
  }
})
