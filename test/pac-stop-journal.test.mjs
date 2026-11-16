import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { createPacStopJournal } from '../src/pac-stop-journal.mjs'

test('persists exclusive stop claims across instances without storing identities', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pac-stop-journal-'))
  try {
    const first = createPacStopJournal(directory), second = createPacStopJournal(directory)
    const results = await Promise.allSettled([first.claim('private-session', 'private-task'), second.claim('private-session', 'private-task')])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(results.filter(result => result.status === 'rejected').length, 1)
    await assert.rejects(createPacStopJournal(directory).claim('private-session', 'private-task'), /already requested/)
    await first.claim('another-session', 'private-task')
    await first.claim('private-session', 'another-task')
    for (const file of await readdir(directory)) {
      assert.match(file, /^[a-f0-9]{64}\.stop$/)
      assert.doesNotMatch(await readFile(join(directory, file), 'utf8'), /private-session|private-task/)
    }
    await assert.rejects(first.claim('session', 'bad task'), /Invalid/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('rejects the same claim from a restarted process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pac-stop-process-'))
  const run = promisify(execFile)
  const moduleUrl = new URL('../src/pac-stop-journal.mjs', import.meta.url).href
  const script = `const {createPacStopJournal}=await import(${JSON.stringify(moduleUrl)});await createPacStopJournal(process.argv[1]).claim('session','task')`
  try {
    await run(process.execPath, ['--input-type=module', '-e', script, directory], { windowsHide: true, timeout: 10000 })
    await assert.rejects(run(process.execPath, ['--input-type=module', '-e', script, directory], { windowsHide: true, timeout: 10000 }), /already requested/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
