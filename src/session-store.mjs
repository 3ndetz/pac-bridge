import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

function validate(record, sessionId) {
  if (!record || record.version !== 1 || record.sessionId !== sessionId ||
      !['pacId', 'remoteSessionId', 'model', 'workspace'].every((key) => typeof record[key] === 'string' && record[key]) ||
      !isAbsolute(record.workspace)) throw new Error('Invalid PAC session record')
  return { version: 1, sessionId, pacId: record.pacId, remoteSessionId: record.remoteSessionId, model: record.model, workspace: record.workspace }
}

export function createSessionStore(directory) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw new Error('An absolute session store path is required')
  function filename(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 1024) throw new Error('Invalid session identity')
    return join(directory, `${createHash('sha256').update(sessionId).digest('hex')}.json`)
  }
  return {
    async read(sessionId) {
      let raw
      try { raw = await readFile(filename(sessionId), 'utf8') } catch (error) { if (error.code === 'ENOENT') return null; throw error }
      if (Buffer.byteLength(raw, 'utf8') > 65536) throw new Error('PAC session record is too large')
      return validate(JSON.parse(raw), sessionId)
    },
    async write(record) {
      const checked = validate(record, record?.sessionId)
      const destination = filename(checked.sessionId)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const temporary = join(directory, `${randomUUID()}.tmp`)
      let file
      try {
        file = await open(temporary, 'wx', 0o600)
        await file.writeFile(JSON.stringify(checked), 'utf8')
        await file.sync()
        await file.close()
        file = undefined
        await rename(temporary, destination)
      } finally {
        await file?.close()
        try { await unlink(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
      }
    },
  }
}
