import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { planSessionOwnershipMigration } from '../src/session-ownership-migration.mjs'

const usage = 'Usage: node scripts/migrate-session-owners.mjs --mapping <absolute-private-json> --owners-dir <absolute-controller-directory> [--apply --plan-hash <reviewed-sha256>]'
const args = process.argv.slice(2), options = {}
try {
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    if (!['--mapping', '--owners-dir', '--apply', '--plan-hash'].includes(key) || Object.hasOwn(options, key)) throw new Error(usage)
    if (key === '--apply') options[key] = true
    else { if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(usage); options[key] = args[++i] }
  }
  if (!isAbsolute(options['--mapping'] || '') || !isAbsolute(options['--owners-dir'] || '') ||
      Boolean(options['--apply']) !== Boolean(options['--plan-hash'])) throw new Error(usage)
  const path = options['--mapping']
  if ((await lstat(path)).isSymbolicLink()) throw new Error('Invalid ownership migration input')
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  let manifest
  try {
    const stat = await file.stat(), limit = 1024 * 1024
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new Error('Invalid ownership migration input')
    const bytes = Buffer.alloc(limit + 1), { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    if (bytesRead > limit) throw new Error('Invalid ownership migration input')
    manifest = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'))
  } finally { await file.close() }
  const plan = await planSessionOwnershipMigration({ manifest, directory: options['--owners-dir'] })
  const summary = { planHash: plan.planHash, total: plan.total, alreadyBound: plan.alreadyBound, pending: plan.pending, applied: false }
  if (options['--apply']) { await plan.apply(options['--plan-hash']); summary.applied = true }
  process.stdout.write(JSON.stringify(summary) + '\n')
} catch (error) {
  const message = error.message === usage || /^(Invalid ownership migration|Ownership migration (conflicts|plan fingerprint))/.test(error.message)
    ? error.message : 'Ownership migration failed; preserve existing records and review the private input'
  process.stderr.write(message + '\n')
  process.exitCode = 1
}
