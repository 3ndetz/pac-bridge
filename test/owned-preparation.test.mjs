import { removeOwnedTestRoot } from './fixtures/owned-test-root.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { PassThrough } from 'node:stream'

const host = fileURLToPath(new URL('./fixtures/windows-test-owned-job-host.ps1', import.meta.url))
const worker = fileURLToPath(new URL('./fixtures/owned-preparation-worker.mjs', import.meta.url))
const remoteWorker = fileURLToPath(new URL('./fixtures/owned-preparation-remote-worker.mjs', import.meta.url))
const bound = (promise, ms) => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('deadline exceeded')), ms) })]).finally(() => clearTimeout(timer)) }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

for (const phase of ['stage', 'extract', 'hash']) for (const disruption of ['timeout', 'disconnect']) test(`owned preparation ${phase} ${disruption} retains ownership until zero`, { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-preparation-'))
  const id = randomBytes(16).toString('hex')
  await writeFile(join(root, 'test-id'), id, { flag: 'wx' })
  const spec = Buffer.from(JSON.stringify({ command: process.execPath, args: [worker, phase], cwd: root, nonce: id, deadlineMs: 50000 })).toString('base64')
  const hostProcess = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', host, spec], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  hostProcess.stderr.resume()
  const closed = once(hostProcess, 'close')
  const lines = createInterface({ input: hostProcess.stdout })[Symbol.asyncIterator]()
  let ready = false, confirmed = false
  try {
    assert.equal((await bound(lines.next(), 20000)).value, `OWNED_READY ${id}`)
    ready = true
    await bound((async () => { while (true) { try { if (await readFile(join(root, 'phase'), 'utf8') === phase) return } catch {} await delay(50) } })(), 25000)
    if (disruption === 'disconnect') { const transport = new PassThrough(); const disconnected = once(transport, 'close'); transport.destroy(); await bound(disconnected, 1000); assert.equal(transport.destroyed, true) }
    else await assert.rejects(bound(new Promise(() => {}), 100), /deadline exceeded/)
  } finally {
    if (ready) {
      await writeFile(join(root, 'stop.tmp'), id, { flag: 'wx' })
      await rename(join(root, 'stop.tmp'), join(root, 'stop.signal'))
      confirmed = (await bound(lines.next(), 20000)).value === `OWNED_CLOSED ${id}` && (await bound(closed, 10000))[0] === 0
    }
    if (confirmed) await removeOwnedTestRoot(root, 'pac-preparation-')
  }
  assert.equal(confirmed, true)
})

test('owned preparation completes stage extract and hash before zero and cleanup', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-preparation-'))
  const id = randomBytes(16).toString('hex')
  await writeFile(join(root, 'test-id'), id, { flag: 'wx' })
  const spec = Buffer.from(JSON.stringify({ command: process.execPath, args: [worker, 'complete'], cwd: root, nonce: id, deadlineMs: 50000 })).toString('base64')
  const hostProcess = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', host, spec], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  hostProcess.stderr.resume()
  const closed = once(hostProcess, 'close')
  const lines = createInterface({ input: hostProcess.stdout })[Symbol.asyncIterator]()
  let ready = false, confirmed = false
  try {
    assert.equal((await bound(lines.next(), 20000)).value, `OWNED_READY ${id}`)
    ready = true
    assert.equal((await bound(lines.next(), 30000)).value, `OWNED_EARLY_EXIT ${id}`)
    assert.equal(await readFile(join(root, 'result'), 'utf8'), createHash('sha256').update('synthetic').digest('hex'))
  } finally {
    if (ready) {
      await writeFile(join(root, 'stop.tmp'), id, { flag: 'wx' })
      await rename(join(root, 'stop.tmp'), join(root, 'stop.signal'))
      confirmed = (await bound(lines.next(), 20000)).value === `OWNED_CLOSED ${id}` && (await bound(closed, 10000))[0] === 0
    }
    if (confirmed) await removeOwnedTestRoot(root, 'pac-preparation-')
  }
  assert.equal(confirmed, true)
})

for (const phase of ['extract-running', 'hash-boundary', 'hash-running']) test(`owned real operation loop ${phase} stops with zero active`, { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-preparation-'))
  const id = randomBytes(16).toString('hex')
  await writeFile(join(root, 'test-id'), id, { flag: 'wx' })
  const spec = Buffer.from(JSON.stringify({ command: process.execPath, args: [remoteWorker, phase], cwd: root, nonce: id, deadlineMs: 50000 })).toString('base64')
  const hostProcess = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', host, spec], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  hostProcess.stderr.resume()
  const closed = once(hostProcess, 'close')
  const lines = createInterface({ input: hostProcess.stdout })[Symbol.asyncIterator]()
  let ready = false, confirmed = false
  try {
    assert.equal((await bound(lines.next(), 20000)).value, `OWNED_READY ${id}`)
    ready = true
    await bound((async () => { while (true) { try { if (await readFile(join(root, 'phase'), 'utf8') === phase) return } catch {} await delay(50) } })(), 30000)
  } finally {
    if (ready) {
      await writeFile(join(root, 'stop.tmp'), id, { flag: 'wx' })
      await rename(join(root, 'stop.tmp'), join(root, 'stop.signal'))
      confirmed = (await bound(lines.next(), 20000)).value === `OWNED_CLOSED ${id}` && (await bound(closed, 10000))[0] === 0
    }
    if (confirmed) await removeOwnedTestRoot(root, 'pac-preparation-')
  }
  assert.equal(confirmed, true)
})

test('phase failure preserves failure and records confirmed zero before cleanup', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-preparation-'))
  const id = randomBytes(16).toString('hex')
  await writeFile(join(root, 'test-id'), id, { flag: 'wx' })
  const spec = Buffer.from(JSON.stringify({ command: process.execPath, args: [remoteWorker, 'extract-running'], cwd: root, nonce: id, deadlineMs: 50000 })).toString('base64')
  const hostProcess = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', host, spec], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  hostProcess.stderr.resume()
  const closed = once(hostProcess, 'close')
  const lines = createInterface({ input: hostProcess.stdout })[Symbol.asyncIterator]()
  let ready = false, outcome = 'unknown', error
  try {
    assert.equal((await bound(lines.next(), 20000)).value, `OWNED_READY ${id}`)
    ready = true
    await bound((async () => { while (true) { try { if (await readFile(join(root, 'phase'), 'utf8') === 'extract-running') return } catch {} await delay(50) } })(), 30000)
    throw new Error('synthetic phase failure')
  } catch (caught) { error = caught }
  finally {
    if (ready) {
      try {
        await writeFile(join(root, 'stop.tmp'), id, { flag: 'wx' })
        await rename(join(root, 'stop.tmp'), join(root, 'stop.signal'))
        if ((await bound(lines.next(), 20000)).value === `OWNED_CLOSED ${id}` && (await bound(closed, 10000))[0] === 0) outcome = 'confirmed'
      } catch { outcome = 'unknown' }
    }
    if (outcome === 'confirmed') await removeOwnedTestRoot(root, 'pac-preparation-')
  }
  assert.match(error?.message || '', /synthetic phase failure/)
  assert.equal(outcome, 'confirmed')
})
