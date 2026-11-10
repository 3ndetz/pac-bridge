import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export function spawnContained(command, args, options) {
  if (process.platform !== 'win32') return spawn(command, args, { ...options, detached: true })
  const spec = Buffer.from(JSON.stringify({ command, args, cwd: options.cwd || process.cwd(), interactive: options.interactive === true }), 'utf8').toString('base64')
  return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    fileURLToPath(new URL('./windows-job-host.ps1', import.meta.url)), spec], { ...options, windowsHide: true, detached: false })
}

export function stopContained(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    if (!child.kill()) throw new Error('Could not terminate the Windows job host; outcome is unknown')
  } else {
    try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
  }
}
