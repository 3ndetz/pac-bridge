import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { loadOpenCodeBuiltins } from '../src/opencode-builtins.mjs'

function fakeSpawn(payload, { exit = true } = {}) {
  return () => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    queueMicrotask(() => { if (payload !== undefined) child.stdout.write(payload); if (exit) child.emit('close', 0) })
    return child
  }
}

test('only exposes built-in entries from bounded OpenCode output', async () => {
  const data = [
    { name: 'built-in', description: 'Built in', content: 'text', location: '<built-in>' },
    { name: 'private-file', description: 'File', content: 'secret', location: '/home/private/SKILL.md' },
  ]
  const result = await loadOpenCodeBuiltins({ binary: process.execPath, cwd: tmpdir(), spawn: fakeSpawn(JSON.stringify(data)) })
  assert.deepEqual(result, [{ name: 'built-in', description: 'Built in', content: 'text' }])
  await assert.rejects(loadOpenCodeBuiltins({ binary: process.execPath, cwd: tmpdir(), maxOutputBytes: 3, spawn: fakeSpawn('too long') }), /exceeds the limit/)
  await assert.rejects(loadOpenCodeBuiltins({ binary: process.execPath, cwd: tmpdir(), timeoutMs: 20, spawn: fakeSpawn(undefined, { exit: false }) }), /timed out/)
  await assert.rejects(loadOpenCodeBuiltins({ binary: process.execPath, cwd: tmpdir(), spawn: fakeSpawn('bad json') }), /Invalid OpenCode/)
})
