import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { spawnContained, stopContainedAndWait } from '../src/spawn-contained.mjs'
const linux = process.platform === 'linux'
const host = fileURLToPath(new URL('../src/linux-process-host.py', import.meta.url))
function launch(args, options = {}) {
  const spec = Buffer.from(JSON.stringify({ command: process.execPath, args, nonce: randomBytes(16).toString('hex') })).toString('base64')
  return spawn('/usr/bin/python3', ['-I', '-S', host, spec], { ...options, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] })
}
async function closed(child) {
  if (child.exitCode !== null || child.signalCode !== null) return [child.exitCode, child.signalCode]
  return await once(child, 'close')
}

test('Linux owner preserves command stdin, stdout and nonzero exit status', { skip: !linux, timeout: 10000 }, async () => {
  const child = launch(['-e', "process.stdin.on('data',x=>process.stdout.write(x));process.stdin.on('end',()=>process.exitCode=7)"])
  let output = '', errors = ''
  child.stdout.on('data', x => { output += x }); child.stderr.on('data', x => { errors += x })
  child.stdin.end('synthetic echo')
  assert.deepEqual(await closed(child), [7, null], errors)
  assert.equal(output, 'synthetic echo')
})

for (const trigger of ['control-eof', 'signal', 'command-exit']) test(`Linux owner reaps a detached descendant after ${trigger}`, { skip: !linux, timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-linux-owner-'))
  const descendant = "setTimeout(()=>require('node:fs').writeFileSync('late-result','unexpected'),1500)"
  const script = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:'ignore'}).unref();process.stdout.write('READY\\n');${trigger === 'command-exit' ? 'process.exitCode=9' : 'setInterval(()=>{},1000)'}`
  const child = launch(['-e', script], { cwd: root })
  child.stderr.resume()
  try {
    const [chunk] = await once(child.stdout, 'data')
    assert.match(chunk.toString(), /READY/)
    if (trigger === 'control-eof') child.stdio[3].destroy()
    if (trigger === 'signal') child.kill('SIGTERM')
    const result = await closed(child)
    assert.deepEqual(result, trigger === 'command-exit' ? [9, null] : [null, 'SIGKILL'])
    await new Promise(resolve => setTimeout(resolve, 1700))
    assert.equal(await access(join(root, 'late-result')).then(() => true, () => false), false)
  } finally {
    // Request cleanup only through the retained host's control pipe.
    child.stdio[3].destroy()
    await closed(child)
    await rm(root, { recursive: true, force: true })
  }
})


test('stopping one Linux owner cannot stop another independent command', { skip: !linux, timeout: 10000 }, async () => {
  const first = launch(['-e', "process.stdout.write('READY');setInterval(()=>{},1000)"])
  const second = launch(['-e', "process.stdout.write('READY');process.stdin.on('data',x=>process.stdout.write(x))"])
  first.stderr.resume(); second.stderr.resume()
  try {
    await Promise.all([once(first.stdout, 'data'), once(second.stdout, 'data')])
    first.stdio[3].destroy()
    await closed(first)
    const answer = once(second.stdout, 'data')
    second.stdin.write('still-owned-separately')
    assert.equal((await answer)[0].toString(), 'still-owned-separately')
    second.stdin.end()
    assert.deepEqual(await closed(second), [0, null])
  } finally {
    first.stdio[3].destroy(); second.stdio[3].destroy()
    await Promise.all([closed(first), closed(second)])
  }
})


test('Linux owner preserves command stdout EOF while the command is still alive', { skip: !linux, timeout: 10000 }, async () => {
  const child = launch(['-e', "require('node:fs').closeSync(1);setInterval(()=>{},1000)"])
  child.stderr.resume()
  try {
    child.stdout.resume()
    await once(child.stdout, 'end', { signal: AbortSignal.timeout(2000) })
    assert.equal(child.exitCode, null)
    assert.equal(child.signalCode, null)
  } finally { child.stdio[3].destroy(); await closed(child) }
})


test('a stop queued before Linux host bootstrap prevents executing the command', { skip: !linux, timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-linux-owner-'))
  const child = spawnContained(process.execPath, ['-e', "require('node:fs').writeFileSync('must-not-run','unexpected')"], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stderr.resume()
  try {
    await stopContainedAndWait(child, 3000)
    assert.equal(child.pacOwnedExitConfirmed, true)
    assert.equal(await access(join(root, 'must-not-run')).then(() => true, () => false), false)
  } finally { await stopContainedAndWait(child, 3000); await rm(root, { recursive: true, force: true }) }
})

test('an unsupported Linux host cannot claim a confirmed process-tree exit', { skip: !linux, timeout: 10000 }, async () => {
  const previous = process.env.PAC_PYTHON_BINARY
  let child
  try {
    process.env.PAC_PYTHON_BINARY = process.execPath
    child = spawnContained(process.execPath, ['-e', "throw Error('command must not run')"], { stdio: ['ignore', 'pipe', 'pipe'] })
  } finally {
    if (previous === undefined) delete process.env.PAC_PYTHON_BINARY; else process.env.PAC_PYTHON_BINARY = previous
  }
  child.stdout.resume(); child.stderr.resume()
  await assert.rejects(child.pacOwnedExit, /exit is unconfirmed/)
  assert.equal(child.pacOwnedExitConfirmed, false)
  await assert.rejects(stopContainedAndWait(child, 1000), /exit is unconfirmed/)
})


test('Linux cleanup started at exit waits for close and its drain proof', { skip: !linux, timeout: 10000 }, async () => {
  const child = spawnContained(process.execPath, ['-e', 'process.exit(0)'], { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.resume(); child.stderr.resume()
  let cleanup
  await new Promise(resolve => child.once('exit', () => {
    cleanup = stopContainedAndWait(child, 3000)
    cleanup.catch(() => {})
    resolve()
  }))
  await cleanup
  assert.equal(child.pacOwnedExitConfirmed, true)
})
