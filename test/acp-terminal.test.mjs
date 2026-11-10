import assert from 'node:assert/strict'
import { access, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import test from 'node:test'
import { createTerminalManager } from '../src/acp-terminal.mjs'

async function cleanup(root) {
  const path = await realpath(root)
  const parent = await realpath(tmpdir())
  const sub = relative(parent, path)
  if (!sub || sub === '..' || sub.startsWith(`..${sep}`) || isAbsolute(sub) || !basename(path).startsWith('pac-terminal-')) throw new Error('Unsafe test cleanup path')
  await rm(path, { recursive: true, force: true })
}

test('executes, captures and releases a workspace command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-terminal-'))
  const manager = await createTerminalManager({ root, sessionId: 'session', authorize: () => true })
  try {
    const { terminalId } = await manager.create({ sessionId: 'session', command: process.execPath, args: ['-e', 'process.stdout.write("hello"); process.exitCode=7'], cwd: root })
    assert.deepEqual(await manager.waitForExit({ sessionId: 'session', terminalId }), { exitCode: 7, signal: null })
    assert.equal(manager.output({ sessionId: 'session', terminalId }).output, 'hello')
    assert.throws(() => manager.output({ sessionId: 'other', terminalId }), /session/)
    await manager.release({ sessionId: 'session', terminalId })
    assert.throws(() => manager.output({ sessionId: 'session', terminalId }), /Unknown terminal/)
  } finally { await manager.close(); await cleanup(root) }
})

test('preserves command arguments and environment without shell interpretation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-terminal-'))
  const manager = await createTerminalManager({ root, sessionId: 'session', authorize: () => true })
  const values = ['', 'space here', 'a"b', 'trailing\\', 'quoted \\" value', 'кириллица']
  try {
    const { terminalId } = await manager.create({ sessionId: 'session', command: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify({args:process.argv.slice(1),value:process.env.PAC_TERMINAL_TEST}))', ...values],
      cwd: root, env: [{ name: 'PAC_TERMINAL_TEST', value: 'значение с пробелом' }] })
    assert.equal((await manager.waitForExit({ sessionId: 'session', terminalId })).exitCode, 0)
    assert.deepEqual(JSON.parse(manager.output({ sessionId: 'session', terminalId }).output), { args: values, value: 'значение с пробелом' })
  } finally { await manager.close(); await cleanup(root) }
})

test('resolves a command from the inherited PATH', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-terminal-'))
  const manager = await createTerminalManager({ root, sessionId: 'session', authorize: () => true })
  try {
    const { terminalId } = await manager.create({ sessionId: 'session', command: 'node', args: ['-e', 'process.stdout.write("resolved")'], cwd: root })
    assert.equal((await manager.waitForExit({ sessionId: 'session', terminalId })).exitCode, 0)
    assert.equal(manager.output({ sessionId: 'session', terminalId }).output, 'resolved')
  } finally { await manager.close(); await cleanup(root) }
})

test('does not resolve wildcard executable names on Windows', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-terminal-'))
  const manager = await createTerminalManager({ root, sessionId: 'session', authorize: () => true })
  try {
    const { terminalId } = await manager.create({ sessionId: 'session', command: 'node*', args: ['--version'], cwd: root })
    assert.notEqual((await manager.waitForExit({ sessionId: 'session', terminalId })).exitCode, 0)
    assert.doesNotMatch(manager.output({ sessionId: 'session', terminalId }).output, /^v\d/)
  } finally { await manager.close(); await cleanup(root) }
})

test('enforces authorization and terminates a long-running command', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-terminal-'))
  const manager = await createTerminalManager({ root, sessionId: 'session', authorize: ({ args }) => args.includes('setInterval(() => {}, 1000)') })
  try {
    await assert.rejects(manager.create({ sessionId: 'session', command: process.execPath, args: ['-v'], cwd: root }), /not authorized/)
    const { terminalId } = await manager.create({ sessionId: 'session', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: root })
    await manager.kill({ sessionId: 'session', terminalId })
    assert.ok(manager.output({ sessionId: 'session', terminalId }).exitStatus)
    await manager.release({ sessionId: 'session', terminalId })
  } finally { await manager.close(); await cleanup(root) }
})

test('reserves capacity while authorization is pending and cannot start after close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-terminal-'))
  let approve
  const gate = new Promise((resolve) => { approve = resolve })
  const manager = await createTerminalManager({ root, sessionId: 'session', maxSessions: 1, authorize: () => gate })
  try {
    const pending = manager.create({ sessionId: 'session', command: process.execPath, args: ['-v'], cwd: root })
    await assert.rejects(manager.create({ sessionId: 'session', command: process.execPath, args: ['-v'], cwd: root }), /limit/)
    await manager.close()
    approve(true)
    await assert.rejects(pending, /closed/)
  } finally { await manager.close(); await cleanup(root) }
})

test('does not start a command after cancellation while authorization is pending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-terminal-'))
  let approve
  const gate = new Promise((resolve) => { approve = resolve })
  const manager = await createTerminalManager({ root, sessionId: 'session', authorize: () => gate })
  const controller = new AbortController()
  try {
    const pending = manager.create({ sessionId: 'session', command: process.execPath,
      args: ['-e', 'require("node:fs").writeFileSync("unexpected","x")'], cwd: root }, { signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 50))
    controller.abort()
    await assert.rejects(pending, /cancelled/)
    approve(true)
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(await access(join(root, 'unexpected')).then(() => true, () => false), false)
  } finally { await manager.close(); await cleanup(root) }
})

test('closing the manager terminates an active source command', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-terminal-'))
  const manager = await createTerminalManager({ root, sessionId: 'session', authorize: () => true })
  try {
    const { terminalId } = await manager.create({ sessionId: 'session', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: root })
    const completed = manager.waitForExit({ sessionId: 'session', terminalId })
    await manager.close()
    const result = await completed
    assert.ok(result.signal || result.exitCode !== 0)
    assert.throws(() => manager.output({ sessionId: 'session', terminalId }), /Unknown terminal/)
  } finally { await manager.close(); await cleanup(root) }
})
