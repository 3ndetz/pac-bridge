import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, realpath, writeFile, rename, rm } from 'node:fs/promises'
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
