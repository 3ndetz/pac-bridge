import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createTerminalManager } from '../src/acp-terminal.mjs'
import { createProjectHooks } from '../src/project-hooks.mjs'
import { loadOpenCodeBuiltins } from '../src/opencode-builtins.mjs'
function fixtureChild() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no }); promise.catch(() => {})
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pacOwnedExit: promise })
  return { child, resolve, reject }
}

test('terminal exposes no exit status and keeps its slot until ownership proof resolves', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-terminal-proof-')), owned = fixtureChild()
  const manager = await createTerminalManager({ root, sessionId: 'session', authorize: () => true, maxSessions: 1, spawn: () => owned.child })
  try {
    const { terminalId } = await manager.create({ sessionId: 'session', command: 'synthetic', args: [], cwd: root })
    const params = { sessionId: 'session', terminalId }, pending = manager.waitForExit(params)
    let completed = false; pending.then(() => { completed = true })
    owned.child.emit('close', 0, null)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(completed, false)
    assert.equal(manager.output(params).exitStatus, undefined)
    await assert.rejects(manager.create({ sessionId: 'session', command: 'synthetic', args: [], cwd: root }), /limit/)
    owned.resolve(); assert.deepEqual(await pending, { exitCode: 0, signal: null })
    await manager.release(params)
  } finally { owned.resolve(); await manager.close(); await rm(root, { recursive: true, force: true }) }
})

test('terminal refuses successful completion and release when ownership proof is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-terminal-proof-')), owned = fixtureChild()
  const manager = await createTerminalManager({ root, sessionId: 'session', authorize: () => true, maxSessions: 1, spawn: () => owned.child })
  try {
    const { terminalId } = await manager.create({ sessionId: 'session', command: 'synthetic', args: [], cwd: root })
    owned.child.emit('close', 0, null); owned.reject(new Error('synthetic missing proof'))
    const params = { sessionId: 'session', terminalId }
    await assert.rejects(manager.waitForExit(params), { code: 'PAC_PROCESS_EXIT_UNCONFIRMED' })
    await assert.rejects(manager.release(params), /unconfirmed/)
    assert.equal(manager.output(params).exitStatus, undefined)
    await assert.rejects(manager.close(), /unconfirmed/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('source hook refuses an exit-zero result if owned cleanup is unconfirmed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-hook-proof-')), owned = fixtureChild()
  try {
    await mkdir(join(root, '.claude'))
    await writeFile(join(root, '.claude/settings.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'synthetic', args: [] }] }] } }))
    const hooks = await createProjectHooks({ root, home: root, shell: 'synthetic', spawn: () => owned.child })
    const dispatched = hooks.dispatch({ hook_event_name: 'UserPromptSubmit', prompt: 'synthetic' })
    owned.child.stdout.end('{}'); owned.child.emit('close', 0, null); owned.reject(new Error('synthetic missing proof'))
    await assert.rejects(dispatched, { code: 'PAC_PROCESS_EXIT_UNCONFIRMED' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('built-in discovery with valid output waits for separate ownership proof', async () => {
  const owned = fixtureChild()
  const discovery = loadOpenCodeBuiltins({ binary: process.execPath, cwd: tmpdir(), spawn: () => owned.child })
  owned.child.stdout.end('[]'); owned.child.emit('close', 0)
  owned.reject(new Error('synthetic missing proof'))
  await assert.rejects(discovery, /cleanup is unconfirmed/)
})
