import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, relative, sep } from 'node:path'
import test from 'node:test'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createOpencodeTurnJournal } from '../src/opencode-turn-journal.mjs'
import { createOpencodeSessionRouter } from '../src/opencode-session-router.mjs'

const exec = promisify(execFile)

test('a failed turn leaves an exclusive marker that blocks another process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-journal-test-'))
  try {
    const journal = createOpencodeTurnJournal(root)
    const binding = { sessionId: 's', model: 'PAC_a/sonnet', cwd: root }
    let calls = 0
    const openSession = async () => ({ prompt: async () => { calls++; throw new Error('connection lost after write') }, cancel() {}, close() {} })
    const first = createOpencodeSessionRouter({ openSession, journal })
    await assert.rejects(first.prompt(binding, [], () => {}), /connection lost/)
    first.close()
    assert.equal(await journal.isPending('s'), true)
    const second = createOpencodeSessionRouter({ openSession, journal: createOpencodeTurnJournal(root) })
    await assert.rejects(second.prompt(binding, [], () => {}), /outcome is unknown/)
    assert.equal(calls, 1)
    second.close()
  } finally {
    const actual = await realpath(root)
    const local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-journal-test-')) await rm(actual, { recursive: true, force: true })
  }
})

test('a confirmed turn clears its marker, while a competing begin is rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-journal-test-'))
  try {
    const journal = createOpencodeTurnJournal(root)
    const finish = await journal.begin('s')
    await assert.rejects(journal.begin('s'), /outcome is unknown/)
    await finish()
    assert.equal(await journal.isPending('s'), false)
    const binding = { sessionId: 's', model: 'PAC_a/sonnet', cwd: root }
    const router = createOpencodeSessionRouter({ journal, openSession: async () => ({ prompt: async () => ({ stopReason: 'end_turn' }), cancel() {}, close() {} }) })
    await router.prompt(binding, [], () => {})
    assert.equal(await journal.isPending('s'), false)
    router.close()
  } finally {
    const actual = await realpath(root)
    const local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-journal-test-')) await rm(actual, { recursive: true, force: true })
  }
})

test('reconciliation requires an explicit review and a stopped marker owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-journal-test-'))
  try {
    const journal = createOpencodeTurnJournal(root), finish = await journal.begin('active')
    await assert.rejects(journal.reconcile('active'), /explicitly confirm/)
    await assert.rejects(journal.reconcile('active', { outcomeReviewed: true }), /still running/)
    assert.equal(await journal.isPending('active'), true)
    await finish()
    const module = new URL('../src/opencode-turn-journal.mjs', import.meta.url).href
    await exec(process.execPath, ['--input-type=module', '-e', `import {createOpencodeTurnJournal} from ${JSON.stringify(module)}; await createOpencodeTurnJournal(${JSON.stringify(root)}).begin('stopped')`])
    assert.equal(await journal.reconcile('stopped', { outcomeReviewed: true }), true)
    assert.equal(await journal.isPending('stopped'), false)
    assert.equal(await journal.reconcile('stopped', { outcomeReviewed: true }), false)
  } finally {
    const actual = await realpath(root), local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-journal-test-')) await rm(actual, { recursive: true, force: true })
  }
})

test('legacy markers require separate confirmation that the session was stopped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-journal-test-'))
  try {
    const journal = createOpencodeTurnJournal(root), id = 'legacy', name = createHash('sha256').update(id).digest('hex') + '.pending'
    await writeFile(join(root, name), randomUUID())
    await assert.rejects(journal.reconcile(id, { outcomeReviewed: true }), /legacy marker/)
    assert.equal(await journal.reconcile(id, { outcomeReviewed: true, legacyOwnerStopped: true }), true)
    await writeFile(join(root, name), '-'.repeat(36))
    await assert.rejects(journal.reconcile(id, { outcomeReviewed: true, legacyOwnerStopped: true }), /legacy marker/)
  } finally {
    const actual = await realpath(root), local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-journal-test-')) await rm(actual, { recursive: true, force: true })
  }
})

test('recovery command clears only a reviewed stopped session marker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-journal-test-'))
  try {
    const journal = createOpencodeTurnJournal(root)
    const module = new URL('../src/opencode-turn-journal.mjs', import.meta.url).href
    const command = new URL('../scripts/reconcile-uncertain-turn.mjs', import.meta.url)
    await exec(process.execPath, ['--input-type=module', '-e', `import {createOpencodeTurnJournal} from ${JSON.stringify(module)}; await createOpencodeTurnJournal(${JSON.stringify(root)}).begin('ses_test')`])
    const args = [fileURLToPath(command), '--journal-dir', root, '--session-id', 'ses_test']
    await assert.rejects(exec(process.execPath, args), /explicitly confirm/)
    assert.equal(await journal.isPending('ses_test'), true)
    const lock = join(root, createHash('sha256').update('ses_test').digest('hex') + '.pending.lock')
    await exec(process.execPath, ['-e', `const fs=require('node:fs'),crypto=require('node:crypto');fs.writeFileSync(${JSON.stringify(lock)},JSON.stringify({version:1,id:crypto.randomUUID(),pid:process.pid}))`])
    await assert.rejects(exec(process.execPath, [...args, '--confirm-reviewed', '--clear-stale-lock']), /explicitly confirm the session is stopped/)
    const result = await exec(process.execPath, [...args, '--confirm-reviewed', '--clear-stale-lock', '--confirm-session-stopped'])
    assert.match(result.stdout, /earlier turn was not replayed/)
    assert.equal(await journal.isPending('ses_test'), false)
  } finally {
    const actual = await realpath(root), local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-journal-test-')) await rm(actual, { recursive: true, force: true })
  }
})

test('concurrent journal updates admit one owner and leave an existing lock untouched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-journal-test-'))
  try {
    const journal = createOpencodeTurnJournal(root)
    const attempts = await Promise.allSettled([journal.begin('same'), journal.begin('same')])
    assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1)
    assert.equal(attempts.filter(item => item.status === 'rejected').length, 1)
    await attempts.find(item => item.status === 'fulfilled').value()
    const lock = join(root, createHash('sha256').update('locked').digest('hex') + '.pending.lock')
    await writeFile(lock, 'existing-owner')
    await assert.rejects(journal.begin('locked'), /journal is locked/)
    await assert.rejects(journal.reconcile('locked', { outcomeReviewed: true }), /journal is locked/)
  } finally {
    const actual = await realpath(root), local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-journal-test-')) await rm(actual, { recursive: true, force: true })
  }
})

test('concurrent reconciliation never clears a live owner marker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-journal-test-'))
  try {
    const journal = createOpencodeTurnJournal(root)
    for (let i = 0; i < 12; i++) {
      const id = `race${i}`
      const [begin, reconcile] = await Promise.allSettled([journal.begin(id), journal.reconcile(id, { outcomeReviewed: true })])
      assert.notEqual(reconcile.status === 'fulfilled' && reconcile.value, true)
      if (begin.status === 'fulfilled') {
        assert.equal(await journal.isPending(id), true)
        await begin.value()
      }
    }
  } finally {
    const actual = await realpath(root), local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-journal-test-')) await rm(actual, { recursive: true, force: true })
  }
})

test('stale recovery locks require review and reject a live lock owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-journal-test-'))
  try {
    const journal = createOpencodeTurnJournal(root), id = 'locked', lock = join(root, createHash('sha256').update(id).digest('hex') + '.pending.lock')
    await writeFile(lock, JSON.stringify({ version: 1, id: randomUUID(), pid: process.pid }))
    await assert.rejects(journal.clearStaleLock(id), /explicitly confirm/)
    await assert.rejects(journal.clearStaleLock(id, { outcomeReviewed: true, sessionStopped: true }), /still running/)
    await assert.rejects(journal.begin(id), /journal is locked/)
    const competing = await Promise.allSettled([journal.clearStaleLock(id, { outcomeReviewed: true, sessionStopped: true }), journal.begin(id)])
    assert.ok(competing.every(item => item.status === 'rejected'))
    const child = `const fs=require('node:fs'),crypto=require('node:crypto');fs.writeFileSync(${JSON.stringify(lock)},JSON.stringify({version:1,id:crypto.randomUUID(),pid:process.pid}))`
    await exec(process.execPath, ['-e', child])
    assert.equal(await journal.clearStaleLock(id, { outcomeReviewed: true, sessionStopped: true }), true)
    const finish = await journal.begin(id); await finish()
    await writeFile(lock, randomUUID())
    await assert.rejects(journal.clearStaleLock(id, { outcomeReviewed: true, sessionStopped: true }), /legacy lock/)
    assert.equal(await journal.clearStaleLock(id, { outcomeReviewed: true, sessionStopped: true, legacyOwnerStopped: true }), true)
  } finally {
    const actual = await realpath(root), local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-journal-test-')) await rm(actual, { recursive: true, force: true })
  }
})
