import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)

export async function createSearch({ root, sessionId, executable = 'rg', maxBytes = 1024 * 1024, timeoutMs = 30000 }) {
  if (!isAbsolute(root) || typeof sessionId !== 'string' || !sessionId || typeof executable !== 'string' || !executable ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid search configuration')
  const workspace = await realpath(root)

  async function target(params) {
    if (params?.sessionId !== sessionId) throw new Error('Unknown workspace session')
    const requested = params.path || workspace
    if (typeof requested !== 'string' || requested.includes('\0')) throw new Error('Invalid search path')
    const resolved = await realpath(resolve(workspace, requested))
    const local = relative(workspace, resolved)
    if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error('Search path is outside the workspace')
    return resolved
  }

  async function run(args) {
    try {
      const result = await execute(executable, args, { cwd: workspace, maxBuffer: maxBytes, timeout: timeoutMs, windowsHide: true, encoding: 'utf8' })
      return result.stdout
    } catch (error) {
      if (error.code === 1) return error.stdout || ''
      if (error.killed || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error('Search exceeded its time or output limit')
      throw new Error(`Search failed: ${error.stderr?.trim() || error.message}`)
    }
  }

  return {
    async glob(params) {
      const path = await target(params)
      if (typeof params.pattern !== 'string' || !params.pattern || params.pattern.includes('\0')) throw new Error('Invalid glob pattern')
      return { output: await run(['--files', '--hidden', '--glob', '!.git', '--glob', params.pattern, '--', path]) }
    },
    async grep(params) {
      const path = await target(params)
      if (typeof params.pattern !== 'string' || !params.pattern || params.pattern.includes('\0') ||
          (params.glob !== undefined && (typeof params.glob !== 'string' || params.glob.includes('\0'))) ||
          !['files_with_matches', 'content', 'count'].includes(params.outputMode || 'files_with_matches') ||
          (params.ignoreCase !== undefined && typeof params.ignoreCase !== 'boolean')) throw new Error('Invalid search arguments')
      const args = ['--hidden', '--glob', '!.git', '--color', 'never']
      if (params.glob) args.push('--glob', params.glob)
      if (params.ignoreCase) args.push('--ignore-case')
      if ((params.outputMode || 'files_with_matches') === 'files_with_matches') args.push('--files-with-matches')
      if (params.outputMode === 'content') args.push('--line-number')
      if (params.outputMode === 'count') args.push('--count')
      args.push('--', params.pattern, path)
      return { output: await run(args) }
    },
  }
}
