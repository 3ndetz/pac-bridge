import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'

// The optional sender runs on the source machine, outside the model process.
// It receives the event on stdin, never on the command line or in trace logs.
export function notifyTurnComplete({ script, sessionId, turnId, cwd, message }) {
  if (!script) return false
  if (!isAbsolute(script) || typeof sessionId !== 'string' || typeof turnId !== 'string' ||
      typeof cwd !== 'string' || typeof message !== 'string') return false
  try {
    const child = spawn(process.execPath, [script], { detached: true, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] })
    child.on('error', () => {})
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify({ hook_event_name: 'Stop', session_id: sessionId, turn_id: turnId,
      cwd, last_assistant_message: message.slice(0, 1800) }))
    child.unref()
    return true
  } catch { return false }
}
