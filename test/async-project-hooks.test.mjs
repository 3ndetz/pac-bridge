import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAsyncProjectHooks } from '../src/async-project-hooks.mjs'
import { createProjectHooks } from '../src/project-hooks.mjs'

test('asynchronous source hook does not block and returns its context on the next prompt', { timeout: 45000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-async-hook-'))
  const previous = process.env.PAC_TEST_ASYNC_HOOKS
  const manager = createAsyncProjectHooks()
  try {
    process.env.PAC_TEST_ASYNC_HOOKS = '1'
    await mkdir(join(root, '.claude'))
    const script = 'process.stdin.resume();process.stdin.on("end",()=>setTimeout(()=>process.stdout.write("progress\\n"+JSON.stringify({decision:"block",systemMessage:"BACKGROUND_CONTEXT"})),1200))'
    await writeFile(join(root, '.claude', 'settings.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: process.execPath, args: ['-e', script], async: true }] }] } }))
    const hooks = await createProjectHooks({ root, home: root, shell: process.execPath, asyncHooks: manager })
    const started = Date.now()
    assert.deepEqual(await hooks.dispatch({ hook_event_name: 'UserPromptSubmit', prompt: 'first' }), {})
    assert.ok(Date.now() - started < 5000)
    const deadline = Date.now() + 30000
    while (Date.now() < deadline && !manager.hasReady()) await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(manager.hasReady(), true)
    await writeFile(join(root, '.claude', 'settings.json'), '{}')
    const updated = await createProjectHooks({ root, home: root, shell: process.execPath, asyncHooks: manager })
    assert.deepEqual(await updated.dispatch({ hook_event_name: 'UserPromptSubmit', prompt: 'second' }), { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'BACKGROUND_CONTEXT' } })
  } finally {
    await manager.close()
    if (previous === undefined) delete process.env.PAC_TEST_ASYNC_HOOKS; else process.env.PAC_TEST_ASYNC_HOOKS = previous
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('rejects async rewake even when experimental async hooks are enabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-async-rewake-'))
  const previous = process.env.PAC_TEST_ASYNC_HOOKS
  try {
    process.env.PAC_TEST_ASYNC_HOOKS = '1'
    await mkdir(join(root, '.claude'))
    await writeFile(join(root, '.claude', 'settings.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: process.execPath, args: ['-e', 'process.exit(0)'], asyncRewake: true }] }] } }))
    await assert.rejects(createProjectHooks({ root, home: root, shell: process.execPath }), /Unsupported project hook handler/)
  } finally {
    if (previous === undefined) delete process.env.PAC_TEST_ASYNC_HOOKS; else process.env.PAC_TEST_ASYNC_HOOKS = previous
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})


test('closing the session terminates its running source hook', { timeout: 55000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-async-hook-'))
  const previous = process.env.PAC_TEST_ASYNC_HOOKS
  const manager = createAsyncProjectHooks()
  try {
    process.env.PAC_TEST_ASYNC_HOOKS = '1'
    await mkdir(join(root, '.claude'))
    const script = 'const f=require("node:fs");f.writeFileSync("ready","ok");setTimeout(()=>f.writeFileSync("late","bad"),8000)'
    await writeFile(join(root, '.claude', 'settings.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: process.execPath, args: ['-e', script], async: true }] }] } }))
    const hooks = await createProjectHooks({ root, home: root, shell: process.execPath, asyncHooks: manager })
    await hooks.dispatch({ hook_event_name: 'UserPromptSubmit', prompt: 'test' })
    const deadline = Date.now() + 30000
    while (Date.now() < deadline && !await access(join(root, 'ready')).then(() => true, () => false)) await new Promise(resolve => setTimeout(resolve, 100))
    await access(join(root, 'ready'))
    await manager.close()
    await new Promise(resolve => setTimeout(resolve, 9000))
    await assert.rejects(access(join(root, 'late')))
  } finally {
    await manager.close()
    if (previous === undefined) delete process.env.PAC_TEST_ASYNC_HOOKS; else process.env.PAC_TEST_ASYNC_HOOKS = previous
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
