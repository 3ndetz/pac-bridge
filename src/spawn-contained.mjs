import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isAbsolute } from 'node:path'

// A successful Windows kill requests termination through the retained child
// handle. It does not confirm exit; repeated requests must wait for that same
// child rather than interpreting a second kill failure as a new unknown owner.
const requestedStops = new WeakSet()

export function spawnContained(command, args, options = {}) {
  if (process.platform === 'linux') {
    const python = process.env.PAC_PYTHON_BINARY || '/usr/bin/python3'
    if (!isAbsolute(python)) throw new Error('PAC_PYTHON_BINARY must be an absolute path')
    const requested = options.stdio ?? 'pipe'
    const stdio = Array.isArray(requested) ? [...requested] : requested === 'inherit' ? [0, 1, 2] : [requested, requested, requested]
    if (stdio.length > 3) throw new Error('Contained Linux commands reserve the owner control descriptor')
    while (stdio.length < 3) stdio.push('pipe')
    const nonce = randomBytes(16).toString('hex')
    const spec = Buffer.from(JSON.stringify({ command, args, nonce }), 'utf8').toString('base64')
    const child = spawn(python, ['-I', '-S', fileURLToPath(new URL('./linux-process-host.py', import.meta.url)), spec], {
      ...options, stdio: [...stdio, 'pipe'], detached: true,
    })
    let proof = Buffer.alloc(0), invalidProof = false
    child.pacOwnedExitConfirmed = undefined
    child.stdio[3].on('data', chunk => {
      if (proof.length + chunk.length > 128) invalidProof = true
      else proof = Buffer.concat([proof, chunk])
    })
    child.stdio[3].on('error', () => { if (!proof.equals(Buffer.from(`CLOSED ${nonce}\n`, 'ascii'))) invalidProof = true })
    child.pacOwnedExit = new Promise((resolve, reject) => child.once('close', () => {
      child.pacOwnedExitConfirmed = !invalidProof && proof.equals(Buffer.from(`CLOSED ${nonce}\n`, 'ascii'))
      if (child.pacOwnedExitConfirmed) resolve()
      else reject(new Error('Linux process-tree exit is unconfirmed; preserve its workspace'))
    }))
    child.pacOwnedExit.catch(() => {})
    return child
  }
  if (process.platform !== 'win32') return spawn(command, args, { ...options, detached: true })
  const environment = options.env || process.env
  const env = Object.keys(environment).some(key => key.toLowerCase() === 'psmoduleanalysiscachepath')
    ? environment : { ...environment, PSModuleAnalysisCachePath: 'NUL' }
  const spec = Buffer.from(JSON.stringify({ command, args, cwd: options.cwd || process.cwd(), interactive: options.interactive === true }), 'utf8').toString('base64')
  return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    fileURLToPath(new URL('./windows-job-host.ps1', import.meta.url)), spec], { ...options, env, windowsHide: true, detached: false })
}

export function stopContained(child) {
  if (process.platform === 'linux' && child.pacOwnedExitConfirmed === false && (child.exitCode !== null || child.signalCode !== null)) throw new Error('Linux process-tree exit is unconfirmed; preserve its workspace')
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    if (requestedStops.has(child)) return
    if (!child.kill()) throw new Error('Could not terminate the Windows job host; outcome is unknown')
    requestedStops.add(child)
  } else if (process.platform === 'linux') {
    if (requestedStops.has(child)) return
    if (!child.stdio?.[3] || child.stdio[3].destroyed || !child.stdio[3].writable) throw new Error('Could not stop the Linux process owner; outcome is unknown')
    child.stdio[3].write('S')
    requestedStops.add(child)
  } else {
    try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
  }
}


// This confirms the owned child has exited; stopContained alone only requests it.
export function stopContainedAndWait(child, timeoutMs = 1000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid contained stop deadline')
  if (child.pacOwnedExit) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Contained process exit is unconfirmed; preserve its workspace before retrying')), timeoutMs)
      child.pacOwnedExit.then(() => { clearTimeout(timer); resolve() }, error => { clearTimeout(timer); reject(error) })
      try { stopContained(child) } catch (error) { clearTimeout(timer); reject(error) }
    })
  }
  if (child.exitCode !== null && child.exitCode !== undefined || child.signalCode !== null && child.signalCode !== undefined) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer)
      child.removeListener('close', closed)
      if (error) reject(error); else resolve()
    }
    const closed = () => finish()
    const timer = setTimeout(() => finish(new Error('Contained process exit is unconfirmed; preserve its workspace before retrying')), timeoutMs)
    child.once('close', closed)
    try { stopContained(child) } catch (error) { finish(error) }
  })
}
