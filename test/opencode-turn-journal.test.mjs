import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, relative, sep } from 'node:path'
import test from 'node:test'
import { join } from 'node:path'
import { createOpencodeTurnJournal } from '../src/opencode-turn-journal.mjs'
import { createOpencodeSessionRouter } from '../src/opencode-session-router.mjs'

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
