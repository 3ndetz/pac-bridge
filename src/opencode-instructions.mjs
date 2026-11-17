import { lstat, open, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

const enabled = value => value === '1' || value === 'true'
const inside = (root, path) => { const local = relative(root, path); return !isAbsolute(local) && local !== '..' && !local.startsWith('..' + sep) }

// Source harness: OpenCode. Local Claude settings, instructions, rules, hooks
// and implicit imports are deliberately outside this adapter's contract.
export async function readOpenCodeInstructions({ root, home = homedir(), env = process.env, stopAt, nestedTarget, nestedOnly = false, maxFileBytes = 256 * 1024, maxTotalBytes = 1024 * 1024 }) {
  if (!isAbsolute(root) || !isAbsolute(home) || (stopAt !== undefined && !isAbsolute(stopAt)) ||
      (nestedTarget !== undefined && !isAbsolute(nestedTarget)) || (nestedOnly && !nestedTarget) ||
      !Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1) throw new Error('Invalid OpenCode instruction configuration')
  const workspace = await realpath(root), userHome = await realpath(home)
  const projectDisabled = enabled(env.OPENCODE_DISABLE_PROJECT_CONFIG)
  const names = ['AGENTS.md', 'CONTEXT.md']
  const entries = [], seen = new Set()
  let total = 0
  async function read(path, scope) {
    let info
    try { info = await lstat(path) } catch (error) { if (error.code === 'ENOENT') return false; throw error }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('OpenCode instruction file must be a regular unlinked file')
    const actual = await realpath(path)
    const actualScope = await realpath(scope)
    if (!inside(actualScope, actual)) throw new Error('OpenCode instruction resolves outside its configuration root')
    if (seen.has(actual)) return true
    if (entries.length >= 256) throw new Error('Too many OpenCode instruction files')
    const handle = await open(actual, 'r')
    try {
      const current = await handle.stat()
      if (!current.isFile() || current.dev !== info.dev || current.ino !== info.ino) throw new Error('OpenCode instruction changed during read')
      const bytes = Buffer.alloc(maxFileBytes + 1)
      let size = 0
      while (size < bytes.length) { const {bytesRead} = await handle.read(bytes, size, bytes.length - size, size); if (!bytesRead) break; size += bytesRead }
      if (size > maxFileBytes || total + size > maxTotalBytes) throw new Error('OpenCode instructions exceed the size limit')
      const content = new TextDecoder('utf8', {fatal:true}).decode(bytes.subarray(0,size))
      total += size; seen.add(actual)
      if (content) entries.push({path:actual, content})
      return true
    } finally { await handle.close() }
  }
  if (nestedOnly) {
    if (projectDisabled) return entries
    const target = await realpath(nestedTarget)
    if (!inside(workspace,target)) throw new Error('Nested OpenCode instruction target is outside the workspace')
    let directory = dirname(target)
    while (directory !== workspace) {
      for (const name of names) if (await read(join(directory,name),directory)) break
      const parent = dirname(directory)
      if (parent === directory) throw new Error('Nested OpenCode instruction boundary is unavailable')
      directory = parent
    }
    return entries
  }
  if (!projectDisabled) {
    let boundary = stopAt ? await realpath(stopAt) : workspace
    if (stopAt && !inside(boundary,workspace)) throw new Error('OpenCode instruction boundary is not an ancestor')
    if (!stopAt) {
      let directory = workspace
      while (true) {
        try { await lstat(join(directory,'.git')); boundary = directory; break } catch(error) { if(error.code !== 'ENOENT') throw error }
        const parent=dirname(directory); if(parent===directory) break; directory=parent
      }
    }
    const ancestors=[]
    for (let directory=workspace;;directory=dirname(directory)) { ancestors.push(directory); if(directory===boundary) break }
    search: for (const name of names) for (const directory of ancestors) if (await read(join(directory,name),directory)) break search
  }
  const configHome = env.XDG_CONFIG_HOME || join(userHome,'.config')
  if (!isAbsolute(configHome)) throw new Error('Relative OpenCode configuration directory is unsupported')
  const globalRoot = join(configHome,'opencode')
  await read(join(globalRoot,'AGENTS.md'),globalRoot)
  return entries
}
