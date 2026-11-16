import { createHash } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

export function createPacStopJournal(directory) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw new Error('An absolute stop journal path is required')
  return {
    async claim(sessionId, taskId) {
      if (![sessionId, taskId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\s\x00-\x1f\x7f]/.test(value))) throw new Error('Invalid PAC stop identity')
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const key = createHash('sha256').update(JSON.stringify([sessionId, taskId])).digest('hex')
      let file
      try {
        file = await open(join(directory, `${key}.stop`), 'wx', 0o600)
        await file.writeFile('PAC stop claimed; outcome may require review\n', 'utf8')
        await file.sync()
      } catch (error) {
        if (error.code === 'EEXIST') throw new Error('PAC task stop was already requested; review its outcome')
        throw error
      } finally { await file?.close() }
    },
  }
}
