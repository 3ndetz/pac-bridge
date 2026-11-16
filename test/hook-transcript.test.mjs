import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MAX_HOOK_TRANSCRIPT_BYTES, snapshotHookTranscript, withHookTranscript } from '../src/hook-transcript.mjs'

test('copies a bounded transcript for the hook and removes it after success or failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pac-transcript-test-'))
  try {
    const original = join(directory, 'test-session.jsonl')
    const options = { root: directory, sessionId: 'test-session' }
    if (process.platform === 'win32') {
      await assert.rejects(snapshotHookTranscript(original, options), /privacy is not supported/)
      await assert.rejects(withHookTranscript('', async () => {}), /privacy is not supported/)
      return
    }
    await writeFile(original, 'synthetic transcript')
    const snapshot = await snapshotHookTranscript(original, options)
    await assert.rejects(snapshotHookTranscript(original, { root: join(directory, 'outside'), sessionId: 'test-session' }))
    await assert.rejects(snapshotHookTranscript(original, { root: directory, sessionId: 'other' }))
    let temporary
    await withHookTranscript(snapshot, async path => {
      temporary = path
      assert.equal(await snapshotHookTranscript(path, { root: join(path, '..'), sessionId: 'transcript' }), snapshot)
      assert.equal((await stat(path)).mode & 0o777, 0o600)
      assert.equal((await stat(join(path, '..'))).mode & 0o077, 0)
    })
    await assert.rejects(access(temporary))
    await assert.rejects(withHookTranscript(snapshot, async path => { temporary = path; throw new Error('test') }), /test/)
    await assert.rejects(access(temporary))
    await assert.rejects(withHookTranscript('bad!', async () => {}), /Invalid source hook transcript/)
    await assert.rejects(snapshotHookTranscript(join(directory, 'missing.jsonl'), { root: directory, sessionId: 'missing' }), /unavailable/)
    await writeFile(original, Buffer.alloc(MAX_HOOK_TRANSCRIPT_BYTES + 1))
    await assert.rejects(snapshotHookTranscript(original, options), /size limit/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('rejects transcript symlinks escaping the authorized root', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pac-transcript-test-'))
  try {
    const root = join(directory, 'root'), outside = join(directory, 'outside')
    await mkdir(root); await mkdir(outside)
    await writeFile(join(outside, 'test-session.jsonl'), 'outside')
    await symlink(join(outside, 'test-session.jsonl'), join(root, 'test-session.jsonl'))
    await assert.rejects(snapshotHookTranscript(join(root, 'test-session.jsonl'), { root, sessionId: 'test-session' }), /unavailable/)
    await symlink(outside, join(root, 'linked-directory'))
    await assert.rejects(snapshotHookTranscript(join(root, 'linked-directory', 'test-session.jsonl'), { root, sessionId: 'test-session' }), /unavailable/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
