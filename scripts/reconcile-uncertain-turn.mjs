import { isAbsolute } from 'node:path'
import { createOpencodeTurnJournal } from '../src/opencode-turn-journal.mjs'

const args = process.argv.slice(2), flags = new Map()
for (let i = 0; i < args.length; i++) {
  const name = args[i]
  if (!['--journal-dir', '--session-id', '--confirm-reviewed', '--legacy-owner-stopped'].includes(name) || flags.has(name)) throw new Error('Invalid or duplicate reconciliation argument')
  if (['--journal-dir', '--session-id'].includes(name)) {
    const value = args[++i]
    if (!value || value.startsWith('--')) throw new Error('A reconciliation argument value is missing')
    flags.set(name, value)
  } else flags.set(name, true)
}
const directory = flags.get('--journal-dir'), sessionId = flags.get('--session-id')
if (!isAbsolute(directory || '') || typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(sessionId)) {
  throw new Error('Provide an absolute --journal-dir and the original OpenCode --session-id')
}
const changed = await createOpencodeTurnJournal(directory).reconcile(sessionId, {
  outcomeReviewed: flags.has('--confirm-reviewed'), legacyOwnerStopped: flags.has('--legacy-owner-stopped'),
})
process.stdout.write(changed ? 'The reviewed marker was cleared. Resume the original session; the earlier turn was not replayed.\n' : 'No pending marker exists for this session.\n')
