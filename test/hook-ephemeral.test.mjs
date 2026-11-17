import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, link, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotHookTranscript, withEphemeralHookTranscript } from '../src/hook-transcript.mjs'

test('exposes an unlinked snapshot only for the duration of dispatch', { skip: process.platform !== 'linux' }, async () => {
  let path
  await withEphemeralHookTranscript(Buffer.from('synthetic').toString('base64'), async value => {
    path = value
    assert.equal(await readFile(path, 'utf8'), 'synthetic')
    const child = await promisify(execFile)(process.execPath, ['-e', 'process.stdout.write(require("node:fs").readFileSync(process.argv[1],"utf8"))', path])
    assert.equal(child.stdout, 'synthetic')
  })
  await assert.rejects(access(path))
  await assert.rejects(withEphemeralHookTranscript('?', async () => {}), /Invalid/)
  await assert.rejects(withEphemeralHookTranscript('AB==', async () => {}), /Invalid/)
})


test('rejects hard-linked transcript files', { skip: process.platform !== 'linux' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pac-hook-hardlink-'))
  try {
    const original = join(dir, 'original'), linked = join(dir, 'session.jsonl')
    await writeFile(original, 'synthetic')
    await link(original, linked)
    await assert.rejects(snapshotHookTranscript(linked, { root: dir, sessionId: 'session' }), /unavailable/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})


