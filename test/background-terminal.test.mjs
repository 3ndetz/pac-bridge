import assert from 'node:assert/strict'
import { access, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import test from 'node:test'
import { createTerminalManager } from '../src/acp-terminal.mjs'
import { createBackgroundTerminal } from '../src/background-terminal.mjs'

test('does not publish a background task cancelled during creation', async () => {
  const controller = new AbortController()
  let complete
  const released = []
  const terminal = {
    create: (_params, options) => {
      assert.equal(options.signal, controller.signal)
      return new Promise((resolve) => { complete = resolve })
    },
    release: async (params) => { released.push(params.terminalId) },
  }
  const background = createBackgroundTerminal({ terminal, sessionId: 'session' })
  const starting = background.start({ sessionId: 'session' }, { signal: controller.signal })
  controller.abort()
  complete({ terminalId: 'terminal' })
  await assert.rejects(starting, /cancelled/)
  assert.deepEqual(released, ['terminal'])
  assert.deepEqual(background.snapshot(), [])
})

test('limits concurrent tasks without discarding completed task results', async () => {
  let nextId = 0
  const terminal = {
    create: async () => ({ terminalId: String(++nextId) }),
    waitForExit: async () => ({ exitCode: 0 }),
    output: ({ terminalId }) => ({ output: terminalId }),
    release: async () => {},
  }
  const background = createBackgroundTerminal({ terminal, sessionId: 'session', maxTasks: 1, maxRetainedTasks: 3 })
  const ids = []
  for (let count = 0; count < 3; count++) {
    const { taskId } = await background.start({ sessionId: 'session' })
    ids.push(taskId)
    await background.output({ sessionId: 'session', taskId, block: true })
  }
  for (const [index, taskId] of ids.entries()) {
    const result = await background.output({ sessionId: 'session', taskId, block: false })
    assert.equal(result.output, String(index + 1))
  }
  await assert.rejects(background.start({ sessionId: 'session' }), /history limit/)
})

test('reports background shell output and stops only the requested task', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-background-'))
  const terminal = await createTerminalManager({ root, sessionId: 'session', authorize: () => true })
  const snapshots = []
  const background = createBackgroundTerminal({ terminal, sessionId: 'session', maxTasks: 2, onChange: (tasks) => snapshots.push(tasks) })
  try {
    const first = await background.start({ sessionId: 'session', command: process.execPath, args: ['-e', 'setTimeout(()=>console.log("DONE"),200)'], cwd: root })
    const second = await background.start({ sessionId: 'session', command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: root })
    await assert.rejects(background.start({ sessionId: 'session', command: process.execPath, args: ['-v'], cwd: root }), /limit/)
    assert.equal((await background.output({ sessionId: 'session', taskId: second.taskId, block: false })).status, 'running')
    assert.equal((await background.stop({ sessionId: 'session', taskId: second.taskId })).status, 'stopped')
    const output = await background.output({ sessionId: 'session', taskId: first.taskId, block: true, timeoutMs: 5000 })
    assert.equal(output.status, 'completed')
    assert.match(output.output, /DONE/)
    assert.equal(output.exitStatus.exitCode, 0)
    assert.ok(snapshots.some((tasks) => tasks.length === 2))
    assert.deepEqual(background.snapshot(), [])
    await assert.rejects(background.output({ sessionId: 'other', taskId: first.taskId, block: false }), /session/)
    await assert.rejects(background.stop({ sessionId: 'session', taskId: 'unknown' }), /Unknown/)
  } finally {
    await terminal.close()
    const actual = await realpath(root)
    const local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-background-')) await rm(actual, { recursive: true, force: true })
  }
})

test('stops a Windows Bash child before it can modify the workspace', { timeout: 20000, skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-background-'))
  const terminal = await createTerminalManager({ root, sessionId: 'session', authorize: () => true })
  const background = createBackgroundTerminal({ terminal, sessionId: 'session' })
  try {
    const bash = process.env.PAC_TEST_BASH || join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe')
    const task = await background.start({ sessionId: 'session', command: bash,
      args: ['-c', '(sleep 5; printf unwanted > child-result) & printf started > child-ready; wait'], cwd: root })
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !(await access(join(root, 'child-ready')).then(() => true, () => false))) await new Promise((resolve) => setTimeout(resolve, 50))
    await access(join(root, 'child-ready'))
    const started = Date.now()
    assert.equal((await background.stop({ sessionId: 'session', taskId: task.taskId })).status, 'stopped')
    assert.ok(Date.now() - started < 4000)
    await new Promise((resolve) => setTimeout(resolve, 6000))
    assert.equal(await access(join(root, 'child-result')).then(() => true, () => false), false)
  } finally {
    await terminal.close()
    const actual = await realpath(root)
    const local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-background-')) await rm(actual, { recursive: true, force: true })
  }
})

test('enforces the background command timeout', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-background-'))
  const terminal = await createTerminalManager({ root, sessionId: 'session', authorize: () => true })
  const background = createBackgroundTerminal({ terminal, sessionId: 'session' })
  try {
    const task = await background.start({ sessionId: 'session', command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: root, timeoutMs: 100 })
    const result = await background.output({ sessionId: 'session', taskId: task.taskId, block: true, timeoutMs: 5000 })
    assert.equal(result.status, 'timed_out')
    assert.deepEqual(background.snapshot(), [])
  } finally {
    await terminal.close()
    const actual = await realpath(root)
    const local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-background-')) await rm(actual, { recursive: true, force: true })
  }
})
