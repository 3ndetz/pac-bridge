import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'

const [root, id, host, worker, phase] = process.argv.slice(2)
const bound = (promise, ms) => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('deadline')), ms) })]).finally(() => clearTimeout(timer)) }
if (process.env.PAC_TEST_WATCHER_ACL === '1') {
  const run = promisify(execFile)
  const { stdout } = await run('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide:true, timeout:5000, maxBuffer:8192 })
  const matches = stdout.match(/S-1-(?:\d+-)*\d+/g)
  if (matches?.length !== 1) throw new Error('identity unavailable')
  await run('icacls.exe', [root, '/inheritance:r', '/grant:r', `*${matches[0]}:(OI)(CI)F`], { windowsHide:true, timeout:10000, maxBuffer:8192 })
}
const server = createServer()
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const ownerConnection = once(server, 'connection')
await writeFile(join(root, 'watcher-port'), String(server.address().port), { flag:'wx' })
const [owner] = await bound(ownerConnection, 10000)
server.close()
owner.resume()
const disconnected = once(owner, 'close')
const spec = Buffer.from(JSON.stringify({ command: process.execPath, args: [worker, phase], cwd: root, nonce: id, deadlineMs: 60000 })).toString('base64')
const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', host, spec], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
child.stderr.resume()
const closed = once(child, 'close')
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
let ready = false, disconnectedOwner = false, result = 'unknown'
try {
  if ((await bound(lines.next(), 20000)).value !== `OWNED_READY ${id}`) throw new Error('host not ready')
  ready = true
  await bound(disconnected, 45000)
  disconnectedOwner = true
} catch {} finally {
  if (ready) {
    try {
      await writeFile(join(root, 'stop.tmp'), id, { flag:'wx' })
      await rename(join(root, 'stop.tmp'), join(root, 'stop.signal'))
      let status = (await bound(lines.next(), 20000)).value
      if (status === `OWNED_EARLY_EXIT ${id}`) status = (await bound(lines.next(), 20000)).value
      if (status === `OWNED_CLOSED ${id}` && (await bound(closed, 10000))[0] === 0) result = disconnectedOwner ? 'zero-active-host-exited' : 'timeout-zero-active-host-exited'
    } catch {}
  }
  await writeFile(join(root, 'outcome'), `${id}:${result}`, { flag:'wx' })
}
