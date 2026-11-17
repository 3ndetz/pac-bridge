import { removeOwnedTestRoot } from './fixtures/owned-test-root.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { createInterface } from 'node:readline'

const fixture = name => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
const bound = (promise, ms) => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('deadline exceeded')), ms) })]).finally(() => clearTimeout(timer)) }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitFile = (file, expected) => bound((async () => { while (true) { try { const value = await readFile(file, 'utf8'); if (!expected || value === expected) return value } catch {} await delay(50) } })(), 30000)

for (const phase of ['stage-boundary', 'extract-boundary', 'extract-running', 'hash-boundary', 'hash-running']) test(`watcher closes owned job after owner connection loss at ${phase}`, { skip: process.platform !== 'win32', timeout: 70000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-owner-disconnect-'))
  const id = randomBytes(16).toString('hex')
  await writeFile(join(root, 'test-id'), id, { flag:'wx' })
  const watcher = spawn(process.execPath, [fixture('owned-preparation-disconnect-watcher.mjs'), root, id, fixture('windows-test-owned-job-host.ps1'), fixture('owned-preparation-remote-worker.mjs'), phase], { cwd:root, windowsHide:true, stdio:['ignore', 'ignore', 'ignore'] })
  const exited = once(watcher, 'close')
  let owner, confirmed = false
  try {
    const port = Number(await waitFile(join(root, 'watcher-port')))
    owner = connect(port, '127.0.0.1')
    await bound(once(owner, 'connect'), 5000)
    await waitFile(join(root, 'phase'), phase)
    owner.destroy()
    assert.equal(await waitFile(join(root, 'outcome')), `${id}:zero-active-host-exited`)
    assert.equal((await bound(exited, 10000))[0], 0)
    confirmed = true
  } finally {
    owner?.destroy()
    if (confirmed) await removeOwnedTestRoot(root, 'pac-owner-disconnect-')
  }
})

test('independent watcher in outer job survives owner disconnect and both jobs reach zero', { skip: process.platform !== 'win32', timeout: 70000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-owner-disconnect-'))
  const innerRoot = join(root, 'inner')
  await mkdir(innerRoot)
  const outerId = randomBytes(16).toString('hex'), innerId = randomBytes(16).toString('hex')
  const host = fixture('windows-test-owned-job-host.ps1')
  const spec = Buffer.from(JSON.stringify({ command:process.execPath, args:[fixture('owned-preparation-disconnect-watcher.mjs'), innerRoot, innerId, host, fixture('owned-preparation-remote-worker.mjs'), 'extract-running'], cwd:root, nonce:outerId, deadlineMs: 60000 })).toString('base64')
  const outer = spawn('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',host,spec], { cwd:root, env:{...process.env,PAC_TEST_WATCHER_ACL:'1'}, stdio:['ignore','pipe','pipe'], windowsHide:true })
  outer.stderr.resume()
  const exited = once(outer, 'close'), lines = createInterface({ input:outer.stdout })[Symbol.asyncIterator]()
  let owner, ready = false, confirmed = false
  try {
    assert.equal((await bound(lines.next(), 20000)).value, `OWNED_READY ${outerId}`)
    ready = true
    owner = connect(Number(await waitFile(join(innerRoot, 'watcher-port'))), '127.0.0.1')
    await bound(once(owner, 'connect'), 5000)
    await waitFile(join(innerRoot, 'phase'), 'extract-running')
    owner.destroy()
    assert.equal(await waitFile(join(innerRoot, 'outcome')), `${innerId}:zero-active-host-exited`)
  } finally {
    owner?.destroy()
    if (ready) {
      await writeFile(join(root,'stop.tmp'),outerId,{flag:'wx'})
      await rename(join(root,'stop.tmp'),join(root,'stop.signal'))
      let marker = (await bound(lines.next(),20000)).value
      if (marker === `OWNED_EARLY_EXIT ${outerId}`) marker = (await bound(lines.next(),20000)).value
      confirmed = marker === `OWNED_CLOSED ${outerId}` && (await bound(exited,10000))[0] === 0
    }
    if (confirmed) await removeOwnedTestRoot(root, 'pac-owner-disconnect-')
  }
  assert.equal(confirmed,true)
})
