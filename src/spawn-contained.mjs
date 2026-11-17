import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// A successful Windows kill requests termination through the retained child
// handle. It does not confirm exit; repeated requests must wait for that same
// child rather than interpreting a second kill failure as a new unknown owner.
const requestedStops = new WeakSet()

export function spawnContained(command, args, options) {
  if (process.platform !== 'win32') return spawn(command, args, { ...options, detached: true })
  const environment = options.env || process.env
  const env = Object.keys(environment).some(key => key.toLowerCase() === 'psmoduleanalysiscachepath')
    ? environment : { ...environment, PSModuleAnalysisCachePath: 'NUL' }
  const spec = Buffer.from(JSON.stringify({ command, args, cwd: options.cwd || process.cwd(), interactive: options.interactive === true }), 'utf8').toString('base64')
  return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    fileURLToPath(new URL('./windows-job-host.ps1', import.meta.url)), spec], { ...options, env, windowsHide: true, detached: false })
}

export function stopContained(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    if (requestedStops.has(child)) return
    if (!child.kill()) throw new Error('Could not terminate the Windows job host; outcome is unknown')
    requestedStops.add(child)
  } else {
    try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
  }
}


// This confirms the owned child has exited; stopContained alone only requests it.
export function stopContainedAndWait(child, timeoutMs = 1000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid contained stop deadline')
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
