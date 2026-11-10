import { lstat, open, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, dirname, basename, sep } from 'node:path'

function within(root, target) {
  const path = relative(root, target)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

export async function createWorkspace({ root, sessionId, maxBytes = 8 * 1024 * 1024 }) {
  if (!isAbsolute(root) || typeof sessionId !== 'string' || !sessionId || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('Invalid workspace configuration')
  }
  const requestedRoot = resolve(root)
  const realRoot = await realpath(root)

  async function targetFor(path, writing) {
    if (typeof path !== 'string' || !path || path.includes('\0')) throw new Error('A workspace path is required')
    const requested = isAbsolute(path) ? resolve(path) : resolve(requestedRoot, path)
    if (!within(requestedRoot, requested) && !within(realRoot, requested)) throw new Error('Path is outside the workspace')
    let target
    try {
      target = await realpath(requested)
    } catch (error) {
      if (!writing || error.code !== 'ENOENT') throw error
      try {
        if ((await lstat(requested)).isSymbolicLink()) throw new Error('Dangling symbolic links are not writable')
      } catch (statError) {
        if (statError.code !== 'ENOENT') throw statError
      }
      target = resolve(await realpath(dirname(requested)), basename(requested))
    }
    if (!within(realRoot, target)) throw new Error('Path resolves outside the workspace')
    return target
  }

  function checkSession(params) {
    if (!params || params.sessionId !== sessionId) throw new Error('Unknown workspace session')
  }

  async function readBounded(path) {
    const file = await open(await targetFor(path, false), 'r')
    try {
      const content = Buffer.alloc(maxBytes + 1)
      let bytesRead = 0
      while (bytesRead < content.length) {
        const result = await file.read(content, bytesRead, content.length - bytesRead, bytesRead)
        if (!result.bytesRead) break
        bytesRead += result.bytesRead
      }
      if (bytesRead > maxBytes) throw new Error('File exceeds the workspace read limit')
      return content.subarray(0, bytesRead)
    } finally { await file.close() }
  }

  return {
    async readTextFile(params) {
      checkSession(params)
      const { line = 1, limit } = params
      if (!Number.isSafeInteger(line) || line < 1 || (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))) {
        throw new Error('Invalid line or limit')
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(params.path))
      if (line === 1 && limit === undefined) return { content: text }
      const lines = text.match(/[^\n]*\n|[^\n]+$/g) || []
      return { content: lines.slice(line - 1, limit === undefined ? undefined : line - 1 + limit).join('') }
    },
    async readImageFile(params) {
      checkSession(params)
      const data = await readBounded(params.path)
      let mimeType
      if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mimeType = 'image/png'
      else if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) mimeType = 'image/jpeg'
      else if (['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))) mimeType = 'image/gif'
      else if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') mimeType = 'image/webp'
      else throw new Error('Unsupported image format')
      return { data: data.toString('base64'), mimeType }
    },
    async writeTextFile(params) {
      checkSession(params)
      if (typeof params.content !== 'string' || Buffer.byteLength(params.content, 'utf8') > maxBytes) {
        throw new Error('Invalid content or workspace write limit exceeded')
      }
      await writeFile(await targetFor(params.path, true), params.content, 'utf8')
      return {}
    },
  }
}
