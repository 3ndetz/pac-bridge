import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, access, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { spawnContained, stopContained, stopContainedAndWait } from '../src/spawn-contained.mjs'
const windows = process.platform === 'win32'
function owned(script, cwd) {
  const child = spawnContained(process.execPath, ['-e', script], { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  child.stderr.resume()
  return child
}
async function ready(child) { const [bytes] = await once(child.stdout, 'data'); assert.match(bytes.toString(), /READY/) }

test('Windows owner preserves standard stdin and nonzero command exit with confirmed drain', { skip: !windows, timeout: 15000 }, async () => {
  const child = owned("process.stdin.on('data',x=>process.stdout.write(x));process.stdin.on('end',()=>process.exitCode=7)")
  let output = ''; child.stdout.on('data', x => { output += x })
  child.stdin.end('synthetic-input')
  const [code] = await once(child, 'close')
  await child.pacOwnedExit
  assert.equal(code, 7); assert.equal(output, 'synthetic-input'); assert.equal(child.pacOwnedExitConfirmed, true)
})

test('Windows owner confirms detached descendant cleanup after ordinary command exit', { skip: !windows, timeout: 15000 }, async () => {
  const child = owned("require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}).unref();process.exitCode=9")
  child.stdout.resume()
  const [code] = await once(child, 'close'); await child.pacOwnedExit
  assert.equal(code, 9); assert.equal(child.pacOwnedExitConfirmed, true)
})

test('Windows owner cancellation before bootstrap prevents command side effects', { skip: !windows, timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-win-owner-bootstrap-')), marker = join(root, 'must-not-exist')
  const child = owned("require('node:fs').writeFileSync('must-not-exist','bad')", root)
  child.stdout.resume()
  try {
    stopContained(child); await child.pacOwnedExit
    assert.equal(child.pacOwnedExitConfirmed, true)
    await assert.rejects(access(marker), { code: 'ENOENT' })
  } finally { await stopContainedAndWait(child, 10000); await rmdir(root) }
})

test('Windows owners stop their own jobs without stopping an independent command', { skip: !windows, timeout: 20000 }, async () => {
  const first = owned("process.stdout.write('READY');setInterval(()=>{},1000)")
  const second = owned("process.stdout.write('READY');process.stdin.on('data',x=>process.stdout.write(x));setInterval(()=>{},1000)")
  try {
    await Promise.all([ready(first), ready(second)])
    await stopContainedAndWait(first, 10000)
    assert.equal(second.exitCode, null)
    const output = once(second.stdout, 'data'); second.stdin.write('INDEPENDENT')
    assert.equal((await output)[0].toString(), 'INDEPENDENT')
  } finally { await Promise.all([stopContainedAndWait(first, 10000), stopContainedAndWait(second, 10000)]) }
})

test('Windows host loss never claims a confirmed job drain without its acknowledgement', { skip: !windows, timeout: 15000 }, async () => {
  const child = owned("process.stdout.write('READY');setInterval(()=>{},1000)")
  await ready(child)
  const closed = once(child, 'close'); child.kill(); await closed
  await assert.rejects(child.pacOwnedExit, /unconfirmed/)
  assert.equal(child.pacOwnedExitConfirmed, false)
  assert.throws(() => stopContained(child), /unconfirmed/)
})


test('Windows parent loss closes both known command and detached descendant connections', { skip: !windows, timeout: 20000 }, async () => {
  const sockets = new Map(), all = new Set()
  let readyResolve
  const ready = new Promise(resolve => { readyResolve = resolve })
  const server = createServer(socket => {
    all.add(socket)
    let input = ''
    socket.on('data', bytes => { input += bytes.toString(); const index = input.indexOf('\n'); if (index < 0) return; sockets.set(input.slice(0, index), socket); if (sockets.size === 2) readyResolve() })
    socket.on('error', () => {})
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port
  const connect = name => `const socket=require('node:net').connect(${port},'127.0.0.1',()=>socket.write(${JSON.stringify(name + '\n')}));socket.on('data',()=>process.exit(0));setInterval(()=>{},1000);`
  const root = connect('root') + `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(connect('descendant'))}],{detached:true,stdio:'ignore'}).unref();`
  const module = new URL('../src/spawn-contained.mjs', import.meta.url).href
  const actorScript = `const {spawnContained}=await import(${JSON.stringify(module)});const child=spawnContained(process.execPath,['-e',${JSON.stringify(root)}],{stdio:'ignore'});child.on('error',()=>process.exit(2));setInterval(()=>{},1000);`
  const actor = spawn(process.execPath, ['--input-type=module', '-e', actorScript], { stdio: 'ignore', windowsHide: true })
  try {
    await Promise.race([ready, new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Owned fixtures did not connect')), 8000); ready.finally(() => clearTimeout(timer)) })])
    assert.deepEqual([...sockets.keys()].sort(), ['descendant', 'root'])
    const closed = [...sockets.values()].map(socket => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Known owned command connection did not close')), 5000)
      socket.once('close', () => { clearTimeout(timer); resolve() })
    }))
    const actorClosed = once(actor, 'close'); actor.kill(); await actorClosed
    await Promise.all(closed)
  } finally {
    if (actor.exitCode === null && actor.signalCode === null) { const closed = once(actor, 'close'); actor.kill(); await closed }
    // Fallback addresses only these known synthetic connections, never a PID scan.
    for (const socket of all) { if (!socket.destroyed) socket.end('cleanup') }
    server.close()
  }
})
