import { randomBytes } from 'node:crypto'
import { statSync } from 'node:fs'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export function spawnWindowsOwned(command, args, options = {}) {
  if (typeof command !== 'string' || !command || !Array.isArray(args) || args.some(value => typeof value !== 'string')) throw new Error('Invalid Windows command')
  if (['*', '?', '[', ']'].some(value => command.includes(value))) {
    let literal = false
    try { literal = statSync(command).isFile() } catch {}
    if (!literal) throw new Error('Wildcard executable names are unsupported')
  }
  const nonce = randomBytes(16).toString('hex'), pipeName = `pac-owner-${randomBytes(16).toString('hex')}`
  const pipePath = `\\\\.\\pipe\\${pipeName}`
  let child, channel, requested = false, hostClosed = false, invalid = false, proof = false, timer
  let resolveOwned, rejectOwned, settled = false, protocol = Buffer.alloc(0)
  const owned = new Promise((resolve, reject) => { resolveOwned = resolve; rejectOwned = reject })
  owned.catch(() => {})
  function finish() {
    if (!hostClosed || settled) return
    settled = true; clearTimeout(timer)
    child.pacOwnedExitConfirmed = proof && !invalid && protocol.equals(Buffer.from(`READY ${nonce}\nCLOSED ${nonce}\n`, 'ascii'))
    channel?.destroy(); server.close()
    if (child.pacOwnedExitConfirmed) resolveOwned()
    else rejectOwned(new Error('Windows process-tree exit is unconfirmed; preserve its workspace'))
  }
  const server = createServer(socket => {
    if (channel || hostClosed) { socket.destroy(); return }
    channel = socket
    let input = '', ready = false
    socket.on('data', bytes => {
      if (protocol.length + bytes.length > 256) { invalid = true; socket.destroy(); return }
      protocol = Buffer.concat([protocol, bytes])
      input += bytes.toString('ascii')
      if (input.length > 256) { invalid = true; socket.destroy(); return }
      let index
      while ((index = input.indexOf('\n')) >= 0) {
        const line = input.slice(0, index); input = input.slice(index + 1)
        if (!ready && line === `READY ${nonce}`) { ready = true; socket.write(requested ? 'S' : 'G') }
        else if (ready && !proof && line === `CLOSED ${nonce}`) { proof = true }
        else { invalid = true; socket.destroy() }
      }
    })
    socket.on('end', () => { if (input) invalid = true; if (hostClosed) finish() })
    socket.on('error', () => { if (!proof) invalid = true; if (hostClosed) finish() })
  })
  server.on('error', () => { invalid = true; channel?.destroy() })
  server.listen(pipePath)
  const environment = options.env || process.env
  const env = Object.keys(environment).some(key => key.toLowerCase() === 'psmoduleanalysiscachepath')
    ? environment : { ...environment, PSModuleAnalysisCachePath: 'NUL' }
  const spec = Buffer.from(JSON.stringify({ command, args, cwd: options.cwd || process.cwd(), interactive: options.interactive === true, pipeName, nonce }), 'utf8').toString('base64')
  try {
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      fileURLToPath(new URL('./windows-job-host.ps1', import.meta.url)), spec], { ...options, env, windowsHide: true, detached: false })
  } catch (error) { server.close(); throw error }
  child.pacOwnedExit = owned
  child.pacOwnedExitConfirmed = undefined
  child.pacRequestStop = () => {
    if (requested) return
    requested = true
    // Before READY, defer S until the host asks permission to execute.
    if (channel && channel.writable) channel.write('S')
  }
  child.once('close', () => {
    hostClosed = true
    if (invalid || !channel || channel.readableEnded) finish()
    else timer = setTimeout(finish, 1000)
  })
  return child
}
