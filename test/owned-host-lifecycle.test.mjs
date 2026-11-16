import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { access, mkdtemp, realpath, writeFile, rename, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { once } from 'node:events'

const host = fileURLToPath(new URL('./fixtures/windows-test-owned-job-host.ps1', import.meta.url))
const waitFor = (promise, ms) => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned host deadline exceeded')), ms) })]).finally(() => clearTimeout(timer)) }

for (const mode of ['fail', 'timeout']) test(`owned host synthetic ${mode} closes job before cleanup`, { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-owned-lifecycle-'))
  const nonce = randomBytes(16).toString('hex')
  const code = mode === 'fail' ? 'process.exit(7)' : 'setInterval(() => {}, 1000)'
  const spec = Buffer.from(JSON.stringify({ command: process.execPath, args: ['-e', code], cwd: root, nonce, deadlineMs: 30000 })).toString('base64')
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', host, spec], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  child.stderr.resume()
  const exited = once(child, 'close')
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  let confirmed = false
  try {
    assert.equal((await waitFor(lines.next(), 20000)).value, `OWNED_READY ${nonce}`)
    let pending
    if (mode === 'fail') assert.equal((await waitFor(lines.next(), 10000)).value, `OWNED_EARLY_EXIT ${nonce}`)
    else { pending = lines.next(); await assert.rejects(waitFor(pending, 300), /deadline exceeded/) }
    await writeFile(join(root, 'stop.tmp'), nonce, { flag: 'wx' })
    await rename(join(root, 'stop.tmp'), join(root, 'stop.signal'))
    const marker = await waitFor(pending || lines.next(), 20000)
    assert.equal(marker.value, `OWNED_CLOSED ${nonce}`)
    const [exitCode] = await waitFor(exited, 10000)
    assert.equal(exitCode, 0)
    confirmed = true
  } finally {
    if (confirmed) {
      const actual = await realpath(root)
      const local = relative(await realpath(tmpdir()), actual)
      if (!local || isAbsolute(local) || local === '..' || local.startsWith('..' + sep) || !local.startsWith('pac-owned-lifecycle-')) throw new Error('Refusing unexpected test cleanup path')
      await rm(actual, { recursive: true, force: true })
    }
  }
})


test('owned job rejects a wrong nonce and closes the synthetic process tree', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-owned-lifecycle-'))
  const nonce = randomBytes(16).toString('hex')
  const marker = join(root, 'grandchild-started')
  const grandchild = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');setInterval(() => {}, 1000)`
  const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore', windowsHide: true });setInterval(() => {}, 1000)`
  const spec = Buffer.from(JSON.stringify({ command: process.execPath, args: ['-e', parent], cwd: root, nonce, deadlineMs: 30000 })).toString('base64')
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', host, spec], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  child.stderr.resume()
  const exited = once(child, 'close')
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  let confirmed = false
  try {
    assert.equal((await waitFor(lines.next(), 20000)).value, `OWNED_READY ${nonce}`)
    const deadline = Date.now() + 15000
    while (true) {
      try { await access(marker); break } catch (error) { if (error.code !== 'ENOENT' || Date.now() >= deadline) throw error }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    await writeFile(join(root, 'stop.signal'), 'wrong', { flag: 'wx' })
    const pending = lines.next()
    await assert.rejects(waitFor(pending, 300), /deadline exceeded/)
    await unlink(join(root, 'stop.signal'))
    await writeFile(join(root, 'stop.tmp'), nonce, { flag: 'wx' })
    await rename(join(root, 'stop.tmp'), join(root, 'stop.signal'))
    assert.equal((await waitFor(pending, 20000)).value, `OWNED_CLOSED ${nonce}`)
    assert.equal((await waitFor(exited, 10000))[0], 0)
    confirmed = true
  } finally {
    if (confirmed) {
      const actual = await realpath(root), local = relative(await realpath(tmpdir()), actual)
      if (!local || isAbsolute(local) || local === '..' || local.startsWith('..' + sep) || !local.startsWith('pac-owned-lifecycle-')) throw new Error('Refusing unexpected test cleanup path')
      await rm(actual, { recursive: true, force: true })
    }
  }
})
