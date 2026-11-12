import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import test from 'node:test'
import { createProjectHooks } from '../src/project-hooks.mjs'

test('does not treat global Claude settings as project hooks when the workspace is home', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pac-hooks-'))
  try {
    const globalConfig = join(home, '.claude'), project = join(home, 'project'), projectConfig = join(project, '.claude')
    await mkdir(globalConfig)
    await mkdir(projectConfig, { recursive: true })
    await writeFile(join(globalConfig, 'settings.json'), JSON.stringify({ theme: 'dark', hooks: { Stop: [] } }))
    const hooks = await createProjectHooks({ root: home, home, shell: process.execPath })
    assert.deepEqual(await hooks.dispatch({ hook_event_name: 'PreToolUse', tool_name: 'Read' }), {})
    await assert.rejects(hooks.dispatch({ hook_event_name: 'Stop', tool_name: 'Read' }), /Unsupported project hook event/)
    await writeFile(join(globalConfig, 'settings.local.json'), JSON.stringify({ hooks: { Stop: [] } }))
    await assert.rejects(createProjectHooks({ root: home, home, shell: process.execPath }), /Unsupported project hook event/)
    await writeFile(join(projectConfig, 'settings.json'), JSON.stringify({ hooks: { Stop: [] } }))
    await assert.rejects(createProjectHooks({ root: project, home, shell: process.execPath }), /Unsupported project hook event/)
  } finally {
    const actual = await realpath(home), local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-hooks-')) await rm(actual, { recursive: true, force: true })
  }
})

test('runs a matching project hook on the source and forwards its decision', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-hooks-'))
  try {
    const config = join(root, '.claude')
    await mkdir(config)
    const script = 'let input="";process.stdin.on("data",x=>input+=x);process.stdin.on("end",()=>{const event=JSON.parse(input);require("node:fs").writeFileSync("observed.json",JSON.stringify({cwd:event.cwd,tool:event.tool_name}));process.stderr.write("blocked by test hook");process.exitCode=2})'
    const postScript = 'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(JSON.stringify({systemMessage:"post hook completed"})))'
    await writeFile(join(config, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Write', hooks: [
      { type: 'command', command: process.execPath, args: ['-e', script], timeout: 5 }
    ] }], PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: process.execPath, args: ['-e', postScript], timeout: 5 }] }] } }))
    const hooks = await createProjectHooks({ root, shell: process.execPath })
    assert.deepEqual(await hooks.dispatch({ hook_event_name: 'PreToolUse', tool_name: 'Read' }), {})
    const decision = await hooks.dispatch({ hook_event_name: 'PreToolUse', tool_name: 'Write' })
    assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny')
    assert.equal(decision.hookSpecificOutput.permissionDecisionReason, 'blocked by test hook')
    assert.deepEqual(await hooks.dispatch({ hook_event_name: 'PostToolUse', tool_name: 'Write' }), { systemMessage: 'post hook completed' })
    assert.deepEqual(JSON.parse(await readFile(join(root, 'observed.json'), 'utf8')), { cwd: await realpath(root), tool: 'Write' })
    await writeFile(join(config, 'settings.json'), JSON.stringify({ hooks: { SessionStart: [] } }))
    await assert.rejects(createProjectHooks({ root, shell: process.execPath }), /Unsupported project hook event/)
    await writeFile(join(config, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'http', url: 'https://example.invalid' }] }] } }))
    await assert.rejects(createProjectHooks({ root, shell: process.execPath }), /Unsupported project hook handler/)
    await writeFile(join(config, 'settings.json'), JSON.stringify({ permissions: { deny: ['Read'] } }))
    await assert.rejects(createProjectHooks({ root, shell: process.execPath }), /Project permission settings/)
    await writeFile(join(config, 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(npm test)'], additionalDirectories: ['/outside'] } }))
    await createProjectHooks({ root, shell: process.execPath })
  } finally {
    const actual = await realpath(root)
    const local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-hooks-')) await rm(actual, { recursive: true, force: true })
  }
})

test('passes tool failure details to a matching source hook', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-hooks-'))
  try {
    const config = join(root, '.claude')
    await mkdir(config)
    const script = 'let input="";process.stdin.on("data",chunk=>input+=chunk);process.stdin.on("end",()=>require("node:fs").writeFileSync("failure.json",input))'
    await writeFile(join(config, 'settings.json'), JSON.stringify({ hooks: { PostToolUseFailure: [{ matcher: '^Read$', hooks: [
      { type: 'command', command: process.execPath, args: ['-e', script], timeout: 5 }
    ] }] } }))
    const hooks = await createProjectHooks({ root, shell: process.execPath })
    await hooks.dispatch({ hook_event_name: 'PostToolUseFailure', tool_name: 'Read', tool_input: { file_path: 'missing.txt' }, error: 'not found', is_interrupt: false })
    const observed = JSON.parse(await readFile(join(root, 'failure.json'), 'utf8'))
    assert.equal(observed.cwd, await realpath(root))
    assert.equal(observed.error, 'not found')
    assert.equal(observed.tool_input.file_path, 'missing.txt')
  } finally {
    const actual = await realpath(root)
    const local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-hooks-')) await rm(actual, { recursive: true, force: true })
  }
})

test('terminates timed-out hook descendants before they can write', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-hooks-'))
  try {
    const config = join(root, '.claude')
    await mkdir(config)
    const descendant = 'setTimeout(()=>require("node:fs").writeFileSync("late-result","unexpected"),5000)'
    const script = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});require('node:fs').writeFileSync('child-ready','yes');setInterval(()=>{},1000)`
    await writeFile(join(config, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [
      { type: 'command', command: process.execPath, args: ['-e', script], timeout: 3 }
    ] }] } }))
    const hooks = await createProjectHooks({ root, shell: process.execPath })
    await assert.rejects(hooks.dispatch({ hook_event_name: 'PreToolUse', tool_name: 'Write' }), /execution limits/)
    await access(join(root, 'child-ready'))
    await new Promise((resolve) => setTimeout(resolve, 6000))
    assert.equal(await access(join(root, 'late-result')).then(() => true, () => false), false)
  } finally {
    const actual = await realpath(root)
    const local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-hooks-')) await rm(actual, { recursive: true, force: true })
  }
})

test('runs distinct matching hooks concurrently, deduplicates handlers, and prioritizes denial', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-hooks-'))
  try {
    const config = join(root, '.claude')
    await mkdir(config)
    const handler = (decision) => ({ type: 'command', command: process.execPath, timeout: 5, args: ['-e',
      `const fs=require('node:fs');fs.appendFileSync('${decision}.txt','x');const timer=setInterval(()=>{if(fs.existsSync('${decision === 'allow' ? 'deny' : 'allow'}.txt')){clearInterval(timer);process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'${decision}'}}))}},25)`] })
    const allow = handler('allow')
    const deny = handler('deny')
    await writeFile(join(config, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Write', hooks: [allow, deny] }] } }))
    await writeFile(join(config, 'settings.local.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Write', hooks: [allow] }] } }))
    const hooks = await createProjectHooks({ root, shell: process.execPath })
    const started = Date.now()
    const decision = await hooks.dispatch({ hook_event_name: 'PreToolUse', tool_name: 'Write' })
    assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny')
    assert.equal(await readFile(join(root, 'allow.txt'), 'utf8'), 'x')
    assert.equal(await readFile(join(root, 'deny.txt'), 'utf8'), 'x')
    assert.ok(Date.now() - started < 5000)
    const unsupported = { type: 'command', command: process.execPath, args: ['-e',
      `process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{file_path:'elsewhere'}}}))`] }
    await writeFile(join(config, 'settings.local.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Write', hooks: [unsupported] }] } }))
    await assert.rejects((await createProjectHooks({ root, shell: process.execPath })).dispatch({ hook_event_name: 'PreToolUse', tool_name: 'Write' }), /Combining these project hook outputs/)
  } finally {
    const actual = await realpath(root)
    const local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-hooks-')) await rm(actual, { recursive: true, force: true })
  }
})
