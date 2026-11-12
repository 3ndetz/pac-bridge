import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// An exclusive marker survives process death. It is cleared only after a
// confirmed completed turn; interrupted effects must be reconciled by a human.
export function createOpencodeTurnJournal(directory) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw new Error('An absolute journal path is required')
  function path(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 512) throw new Error('Invalid session identity')
    return join(directory, `${createHash('sha256').update(sessionId).digest('hex')}.pending`)
  }
  async function exists(filename) {
    try { const file = await open(filename, 'r'); await file.close(); return true }
    catch (error) { if (error.code === 'ENOENT') return false; throw error }
  }
  function assertStopped(value, legacyOwnerStopped, kind) {
    if (Buffer.byteLength(value, 'utf8') > 1024) throw new Error(`Invalid PAC ${kind} record`)
    let record
    try { record = JSON.parse(value) } catch {}
    if (record?.version === 1 && typeof record.id === 'string' && uuid.test(record.id) && Number.isSafeInteger(record.pid) && record.pid > 0) {
      try { process.kill(record.pid, 0); throw new Error(`The PAC ${kind} process is still running; stop it first`) }
      catch (error) { if (error.code !== 'ESRCH') throw error }
    } else if (!legacyOwnerStopped || !uuid.test(value)) {
      throw new Error(`The legacy ${kind} has no process identity; stop its process and explicitly confirm it`)
    }
  }
  async function withLock(sessionId, action) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const filename = `${path(sessionId)}.lock`, repair = `${filename}.repair`, owner = JSON.stringify({ version: 1, id: randomUUID(), pid: process.pid })
    let file
    try {
      if (await exists(repair)) throw new Error('PAC journal is locked; do not alter an active or unreviewed session')
      try { file = await open(filename, 'wx', 0o600) }
      catch (error) { if (error.code === 'EEXIST') throw new Error('PAC journal is locked; do not alter an active or unreviewed session'); throw error }
      await file.writeFile(owner, 'utf8'); await file.sync(); await file.close(); file = undefined
      if (await exists(repair)) throw new Error('PAC journal is locked; do not alter an active or unreviewed session')
      return await action()
    } finally {
      await file?.close()
      try { if (await readFile(filename, 'utf8') === owner) await unlink(filename) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }
  return {
    async isPending(sessionId) {
      try { const file = await open(path(sessionId), 'r'); await file.close(); return true }
      catch (error) { if (error.code === 'ENOENT') return false; throw error }
    },
    async begin(sessionId) {
      const filename = path(sessionId)
      const owner = JSON.stringify({ version: 1, id: randomUUID(), pid: process.pid })
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const locked = async () => await exists(`${filename}.lock`) || await exists(`${filename}.lock.repair`)
      if (await locked()) throw new Error('PAC journal is locked; do not alter an active or unreviewed session')
      let file
      try {
        file = await open(filename, 'wx', 0o600)
        await file.writeFile(owner, 'utf8')
        await file.sync()
      } catch (error) {
        if (error.code === 'EEXIST') throw new Error('Previous PAC turn outcome is unknown; reconciliation is required')
        throw error
      } finally { await file?.close() }
      // Reconciliation may have started between the first lock check and the
      // exclusive create. A live owner must not proceed through that window.
      if (await locked()) {
        if (await readFile(filename, 'utf8') === owner) await unlink(filename)
        throw new Error('PAC journal is locked; do not alter an active or unreviewed session')
      }
      let finished = false
      return async () => {
        if (finished) throw new Error('PAC journal marker was already cleared')
        const value = await readFile(filename, 'utf8')
        if (value !== owner) throw new Error('PAC journal ownership changed; outcome is unknown')
        await unlink(filename)
        finished = true
      }
    },
    async reconcile(sessionId, { outcomeReviewed = false, legacyOwnerStopped = false } = {}) {
      if (!outcomeReviewed) throw new Error('Review and explicitly confirm the unknown outcome before reconciliation')
      return withLock(sessionId, async () => {
        const filename = path(sessionId)
        let value
        try { value = await readFile(filename, 'utf8') } catch (error) { if (error.code === 'ENOENT') return false; throw error }
        assertStopped(value, legacyOwnerStopped, 'marker')
        await unlink(filename)
        return true
      })
    },
    async clearStaleLock(sessionId, { outcomeReviewed = false, sessionStopped = false, legacyOwnerStopped = false } = {}) {
      if (!outcomeReviewed || !sessionStopped) throw new Error('Review the outcome and explicitly confirm the session is stopped before clearing a lock')
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const filename = `${path(sessionId)}.lock`, repair = `${filename}.repair`, owner = randomUUID()
      let file
      try {
        try { file = await open(repair, 'wx', 0o600) }
        catch (error) { if (error.code === 'EEXIST') throw new Error('Another lock repair is active or its repair lock needs review'); throw error }
        await file.writeFile(owner, 'utf8'); await file.sync(); await file.close(); file = undefined
        let value
        try { value = await readFile(filename, 'utf8') } catch (error) { if (error.code === 'ENOENT') return false; throw error }
        assertStopped(value, legacyOwnerStopped, 'lock')
        await unlink(filename)
        return true
      } finally {
        await file?.close()
        try { if (await readFile(repair, 'utf8') === owner) await unlink(repair) }
        catch (error) { if (error.code !== 'ENOENT') throw error }
      }
    },
  }
}
