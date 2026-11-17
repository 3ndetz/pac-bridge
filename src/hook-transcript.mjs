import { constants } from 'node:fs'
import { mkdtemp, open, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, sep } from 'node:path'

export const MAX_HOOK_TRANSCRIPT_BYTES = 1024 * 1024

export async function snapshotHookTranscript(path, { root, sessionId } = {}) {
  if (process.platform !== 'linux') throw new Error('Source hook transcript privacy is not supported on ' + (process.platform === 'win32' ? 'Windows' : 'this platform'))
  if (typeof path !== 'string' || !isAbsolute(path) || typeof root !== 'string' || !isAbsolute(root) ||
      typeof sessionId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(sessionId) || basename(path) !== `${sessionId}.jsonl`) throw new Error('Source hook transcript is unavailable')
  const local = relative(root, path)
  if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error('Source hook transcript is unavailable')
  async function readOnce() {
  const handles = []
  try {
    let directory = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    handles.push(directory)
    const components = [...root.split('/').filter(Boolean), ...local.split('/').slice(0, -1)]
    if (components.some((part) => part === '.' || part === '..')) throw new Error('Invalid transcript location')
    for (const part of components) {
      directory = await open(`/proc/self/fd/${directory.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      handles.push(directory)
    }
    const file = await open(`/proc/self/fd/${directory.fd}/${basename(path)}`, constants.O_RDONLY | constants.O_NOFOLLOW)
    handles.push(file)
    const stat = await file.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.size > MAX_HOOK_TRANSCRIPT_BYTES) throw new Error('Invalid transcript')
    const bytes = Buffer.alloc(MAX_HOOK_TRANSCRIPT_BYTES + 1)
    let length = 0
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length)
      if (!result.bytesRead) break
      length += result.bytesRead
    }
    if (length > MAX_HOOK_TRANSCRIPT_BYTES) throw new Error('Invalid transcript')
    return bytes.subarray(0, length).toString('base64')
  } finally { for (const handle of handles.reverse()) await handle.close() }
  }
  for (let attempt = 0; attempt < 11; attempt++) {
    try { return await readOnce() }
    catch (error) {
      if (error.code !== 'ENOENT' || attempt === 10) throw new Error('Source hook transcript is unavailable or exceeds the size limit')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}

export async function withHookTranscript(encoded, run) {
  if (process.platform === 'win32') throw new Error('Source hook transcript privacy is not supported on Windows')
  if (typeof encoded !== 'string' || encoded.length > 4 * Math.ceil(MAX_HOOK_TRANSCRIPT_BYTES / 3) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('Invalid source hook transcript')
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length > MAX_HOOK_TRANSCRIPT_BYTES || bytes.toString('base64') !== encoded) throw new Error('Invalid source hook transcript')
  const directory = await mkdtemp(join(tmpdir(), 'pac-hook-transcript-'))
  try {
    const path = join(directory, 'transcript.jsonl')
    await writeFile(path, bytes, { mode: 0o600, flag: 'wx' })
    return await run(path)
  } finally { await rm(directory, { recursive: true, force: true }) }
}

export async function withEphemeralHookTranscript(encoded, run) {
  if (process.platform !== 'linux') throw new Error('Source hook transcript privacy is not supported on this platform')
  if (typeof encoded !== 'string' || encoded.length > 4 * Math.ceil(MAX_HOOK_TRANSCRIPT_BYTES / 3) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('Invalid source hook transcript')
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length > MAX_HOOK_TRANSCRIPT_BYTES || bytes.toString('base64') !== encoded) throw new Error('Invalid source hook transcript')
  const directory = await mkdtemp(join(tmpdir(), 'pac-hook-transcript-'))
  let file
  try {
    const path = join(directory, 'transcript.jsonl')
    file = await open(path, 'wx+', 0o600)
    await unlink(path)
    await rm(directory, { recursive: true, force: true })
    await file.writeFile(bytes)
    return await run(`/proc/${process.pid}/fd/${file.fd}`)
  } finally {
    await file?.close()
    await rm(directory, { recursive: true, force: true })
  }
}
