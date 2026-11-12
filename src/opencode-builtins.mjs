import { isAbsolute } from 'node:path'
import { spawnContained, stopContained } from './spawn-contained.mjs'

// Ask the installed version for its own built-ins. Never treat file-backed
// entries in this diagnostic output as built-ins or grant them filesystem access.
export async function loadOpenCodeBuiltins({ binary, cwd, env = process.env, timeoutMs = 10000, maxOutputBytes = 16 * 1024 * 1024, spawn = spawnContained }) {
  if (!isAbsolute(binary) || !isAbsolute(cwd) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) throw new Error('Invalid built-in skill discovery configuration')
  const child = spawn(binary, ['debug', 'skill'], { cwd, env: { ...env, OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true' }, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  return await new Promise((resolve, reject) => {
    let settled = false, size = 0
    const chunks = []
    const finish = (error, result) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      if (error) { try { stopContained(child) } catch {}; reject(error) } else resolve(result)
    }
    const timer = setTimeout(() => finish(new Error('OpenCode built-in skill discovery timed out')), timeoutMs)
    child.on('error', () => finish(new Error('OpenCode built-in skill discovery failed')))
    child.stdout.on('data', (chunk) => {
      size += chunk.length
      if (size > maxOutputBytes) return finish(new Error('OpenCode built-in skill discovery output exceeds the limit'))
      chunks.push(chunk)
    })
    child.on('close', (code) => {
      if (code !== 0) return finish(new Error('OpenCode built-in skill discovery failed'))
      try {
        const entries = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!Array.isArray(entries)) throw new Error('Invalid skill list')
        const builtins = entries.filter((entry) => entry?.location === '<built-in>').map(({ name, description, content }) => ({ name, description, content }))
        finish(null, builtins)
      } catch { finish(new Error('Invalid OpenCode built-in skill discovery output')) }
    })
  })
}
