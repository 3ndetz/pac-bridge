import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

// An exclusive marker survives process death. It is cleared only after a
// confirmed completed turn; interrupted effects must be reconciled by a human.
export function createOpencodeTurnJournal(directory) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw new Error('An absolute journal path is required')
  function path(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 512) throw new Error('Invalid session identity')
    return join(directory, `${createHash('sha256').update(sessionId).digest('hex')}.pending`)
  }
  return {
    async isPending(sessionId) {
      try { const file = await open(path(sessionId), 'r'); await file.close(); return true }
      catch (error) { if (error.code === 'ENOENT') return false; throw error }
    },
    async begin(sessionId) {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const filename = path(sessionId)
      const owner = randomUUID()
      let file
      try {
        file = await open(filename, 'wx', 0o600)
        await file.writeFile(owner, 'utf8')
        await file.sync()
      } catch (error) {
        if (error.code === 'EEXIST') throw new Error('Previous PAC turn outcome is unknown; reconciliation is required')
        throw error
      } finally { await file?.close() }
      let finished = false
      return async () => {
        if (finished) throw new Error('PAC journal marker was already cleared')
        const value = await readFile(filename, 'utf8')
        if (value !== owner) throw new Error('PAC journal ownership changed; outcome is unknown')
        await unlink(filename)
        finished = true
      }
    },
  }
}
