import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { planSessionOwnershipMigration } from '../src/session-ownership-migration.mjs'
import { createSessionOwnershipStore } from '../src/session-ownership.mjs'
const exec = promisify(execFile), a = 'a'.repeat(64), b = 'b'.repeat(64)
const manifest = () => ({ version: 1, bindings: [{ sessionId: 'one', principal: a, evidence: 'private reviewed source binding backup' }, { sessionId: 'two', principal: b, evidence: 'second reviewed source binding backup' }] })
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'pac-ownership-migration-')), directory = join(root, 'owners')
  try { await run({ root, directory, store: createSessionOwnershipStore(directory) }) }
  finally { await rm(root, { recursive: true, force: true }) }
}
test('migration plan is read-only and application requires the exact fingerprint', () => fixture(async ({ directory, store }) => {
  const plan = await planSessionOwnershipMigration({ directory, manifest: manifest() })
  assert.equal(plan.pending, 2)
  await assert.rejects(stat(directory), { code: 'ENOENT' })
  await assert.rejects(plan.apply('f'.repeat(64)), /fingerprint/)
  assert.equal(await store.owner('one'), null)
  await plan.apply(plan.planHash)
  assert.equal(await store.owner('one'), a)
  assert.equal(await store.owner('two'), b)
  const retry = await planSessionOwnershipMigration({ directory, manifest: manifest() })
  assert.equal(retry.planHash, plan.planHash)
  assert.equal(retry.pending, 0)
  await retry.apply(retry.planHash)
}))
test('migration rejects all conflicts before creating any additional binding', () => fixture(async ({ directory, store }) => {
  await store.claim('two', a)
  await assert.rejects(planSessionOwnershipMigration({ directory, manifest: manifest() }), /conflicts/)
  assert.equal(await store.owner('one'), null)
  assert.equal(await store.owner('two'), a)
}))
test('migration checks for a new conflicting claim immediately before applying', () => fixture(async ({ directory, store }) => {
  const plan = await planSessionOwnershipMigration({ directory, manifest: manifest() })
  await store.claim('two', a)
  await assert.rejects(plan.apply(plan.planHash), /conflicts/)
  assert.equal(await store.owner('one'), null)
}))
test('migration requires unique reviewed entries and binds the fingerprint to content and target', () => fixture(async ({ root, directory }) => {
  const data = manifest(), first = await planSessionOwnershipMigration({ directory, manifest: data })
  data.bindings[0].principal = b
  const changed = await planSessionOwnershipMigration({ directory, manifest: data })
  assert.notEqual(first.planHash, changed.planHash)
  assert.notEqual(first.planHash, (await planSessionOwnershipMigration({ directory: join(root, 'other'), manifest: manifest() })).planHash)
  for (const invalid of [{ version: 1, bindings: [] }, { version: 1, bindings: [data.bindings[0], data.bindings[0]] }, { version: 1, bindings: [{ ...data.bindings[0], evidence: '' }] }]) await assert.rejects(planSessionOwnershipMigration({ directory, manifest: invalid }), /Invalid/)
}))
test('migration CLI plans without printing private identities and applies only a reviewed plan', () => fixture(async ({ root, directory, store }) => {
  const path = join(root, 'private.json'), data = manifest()
  data.bindings[0].sessionId = 'PRIVATE_SESSION_MARKER'
  await writeFile(path, JSON.stringify(data))
  const script = fileURLToPath(new URL('../scripts/migrate-session-owners.mjs', import.meta.url))
  const args = [script, '--mapping', path, '--owners-dir', directory]
  const result = await exec(process.execPath, args), plan = JSON.parse(result.stdout)
  assert.equal(result.stdout.includes('PRIVATE_SESSION_MARKER'), false)
  assert.equal(result.stdout.includes(a), false)
  assert.equal(plan.applied, false)
  await assert.rejects(stat(directory), { code: 'ENOENT' })
  assert.equal(JSON.parse((await exec(process.execPath, [...args, '--apply', '--plan-hash', plan.planHash])).stdout).applied, true)
  assert.equal(await store.owner('PRIVATE_SESSION_MARKER'), a)
}))
