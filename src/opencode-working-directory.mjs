import { resolve } from 'node:path'

// HAPI's OpenCode V1 ACP launcher supplies --cwd without setting spawnCwd.
// Resolve discovery against the same directory that OpenCode will use.
export function opencodeWorkingDirectory(args, processCwd) {
  if (!Array.isArray(args) || typeof processCwd !== 'string') throw new Error('Invalid OpenCode working directory')
  if (args[0] !== 'acp') return processCwd
  let requested
  for (let i = 1; i < args.length && args[i] !== '--'; i++) {
    const arg = args[i]
    if (arg !== '--cwd' && !arg.startsWith('--cwd=')) continue
    if (requested !== undefined) throw new Error('Duplicate OpenCode working directory')
    requested = arg === '--cwd' ? args[++i] : arg.slice('--cwd='.length)
    if (typeof requested !== 'string' || !requested || requested.startsWith('--')) throw new Error('Missing OpenCode working directory')
  }
  return requested === undefined ? processCwd : resolve(processCwd, requested)
}

// Once the child is spawned in the target directory, a relative --cwd must
// be made absolute or OpenCode would resolve it a second time.
export function normalizeOpencodeWorkingDirectory(args, cwd) {
  const result = [...args]
  if (result[0] !== 'acp') return result
  for (let i = 1; i < result.length && result[i] !== '--'; i++) {
    if (result[i] === '--cwd') { result[++i] = cwd; break }
    if (result[i].startsWith('--cwd=')) { result[i] = `--cwd=${cwd}`; break }
  }
  return result
}
