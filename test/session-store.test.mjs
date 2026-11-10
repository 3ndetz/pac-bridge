import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { isAbsolute, join, relative, sep } from 'node:path'
import test from 'node:test'
import { createSessionStore } from '../src/session-store.mjs'

test('persists a session-to-PAC binding without embedding secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-session-store-'))
  try {
    const store = createSessionStore(join(root, 'records'))
    const record = { version: 1, sessionId: '../session', pacId: 'controller-a', remoteSessionId: 'remote-a', model: 'sonnet', workspace: root, token: 'never-persist' }
    assert.equal(await store.read(record.sessionId), null)
    await store.write(record)
    const saved = await store.read(record.sessionId)
    assert.deepEqual(saved, { version: 1, sessionId: record.sessionId, pacId: 'controller-a', remoteSessionId: 'remote-a', model: 'sonnet', workspace: root })
    const path = join(root, 'records', `${createHash('sha256').update(record.sessionId).digest('hex')}.json`)
    assert.doesNotMatch(await readFile(path, 'utf8'), /never-persist/)
    await store.write({ ...record, model: 'opus' })
    assert.equal((await store.read(record.sessionId)).model, 'opus')
    await writeFile(path, JSON.stringify({ ...record, sessionId: 'other' }))
    await assert.rejects(store.read(record.sessionId), /Invalid PAC session record/)
    await assert.rejects(store.write({ ...record, workspace: 'relative' }), /Invalid PAC session record/)
  } finally {
    const actual = await realpath(root)
    const local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-session-store-')) await rm(actual, { recursive: true, force: true })
  }
})
