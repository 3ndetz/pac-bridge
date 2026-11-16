import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import test from 'node:test'
import { createProjectHooks } from '../src/project-hooks.mjs'

test('forwards prompt hook context and blocks rejected prompts on the source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-hooks-'))
  try {
    const config = join(root, '.claude')
    await mkdir(config)
    const hook = (script) => ({ type: 'command', command: process.execPath, args: ['-e', script], timeout: 20 })
    const context = { ...hook('let x="";process.stdin.on("data",c=>x+=c);process.stdin.on("end",()=>process.stdout.write("Seen: "+JSON.parse(x).prompt))'), async: false }
    const block = hook('process.stdin.resume();process.stdin.on("end",()=>{process.stderr.write("denied by source policy");process.exitCode=2})')
    await writeFile(join(config, 'settings.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [context, block] }] } }))
    const hooks = await createProjectHooks({ root, home: root, shell: process.execPath })
    assert.deepEqual(await hooks.dispatch({ hook_event_name: 'UserPromptSubmit', prompt: 'hello' }), {
      decision: 'block', reason: 'denied by source policy', hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'Seen: hello' }
    })
    await writeFile(join(config, 'settings.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ matcher: 'hello', hooks: [context] }] } }))
    await assert.rejects(createProjectHooks({ root, home: root, shell: process.execPath }), /matchers are not supported/)
  } finally {
    const actual = await realpath(root), local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-hooks-')) await rm(actual, { recursive: true, force: true })
  }
})

test('forwards global hooks with project hooks and fails closed for unsupported settings', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pac-hooks-'))
  try {
    const globalConfig = join(home, '.claude'), project = join(home, 'project'), projectConfig = join(project, '.claude')
    await mkdir(globalConfig)
    await mkdir(projectConfig, { recursive: true })
    const handler = (decision) => ({ type: 'command', command: process.execPath, args: ['-e',
      `process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'${decision}'}}))`] })
    await writeFile(join(globalConfig, 'settings.json'), JSON.stringify({ theme: 'dark', autoUpdatesChannel: 'stable', env: {}, skipDangerousModePermissionPrompt: true, permissions: { defaultMode: 'acceptEdits' }, hooks: { PreToolUse: [{ hooks: [handler('deny')] }] } }))
    await writeFile(join(projectConfig, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [handler('allow')] }] } }))
    const hooks = await createProjectHooks({ root: project, home, shell: process.execPath })
    assert.equal((await hooks.dispatch({ hook_event_name: 'PreToolUse', tool_name: 'Write' })).hookSpecificOutput.permissionDecision, 'deny')
    const homeHooks = await createProjectHooks({ root: home, home, shell: process.execPath })
    assert.equal((await homeHooks.dispatch({ hook_event_name: 'PreToolUse', tool_name: 'Write' })).hookSpecificOutput.permissionDecision, 'deny')
    for (const settings of [{ permissions: { deny: ['Read'] } }, { disableAllHooks: true }, { permissions: { defaultMode: 'plan' } }, { permissions: { defaultMode: 'dontAsk' } }, { env: { PRIVATE_VALUE: 'secret' } }, { effortLevel: 'unsupported' }, { switchModelsOnFlag: false }, { switchModelsOnFlag: 'invalid' }, { agentPushNotifEnabled: true }, { skipDangerousModePermissionPrompt: 'invalid' }, { skipWorkflowUsageWarning: true }, { autoUpdatesChannel: 'unknown' }, { hooks: { PreToolUse: [{ hooks: [{ type: 'http', url: 'secret' }] }] } }, { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'x', async: true }] }] } }]) {
      await writeFile(join(globalConfig, 'settings.json'), JSON.stringify(settings))
      await assert.rejects(createProjectHooks({ root: project, home, shell: process.execPath }))
    }
    await writeFile(join(globalConfig, 'settings.json'), '{"secret-value":')
    await assert.rejects(createProjectHooks({ root: project, home, shell: process.execPath }), (error) => !error.message.includes('secret-value'))
  } finally {
    const actual = await realpath(home), local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-hooks-')) await rm(actual, { recursive: true, force: true })
  }
})

test('rejects global proxy settings without exposing their values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-proxy-settings-'))
  try {
    await mkdir(join(root, '.claude'))
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY']) {
      const canary = `PAC_SYNTHETIC_${key}_PRIVATE`
      await writeFile(join(root, '.claude', 'settings.json'), JSON.stringify({ env: { [key]: canary } }))
      await assert.rejects(createProjectHooks({ root, home: root, shell: process.execPath }), error => {
        assert.match(error.message, /proxy settings require unsupported controller configuration/)
        assert.equal(error.message.includes(canary), false)
        return true
      })
    }
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
})

test('runs a matching project hook on the source and forwards its decision', { timeout: 45000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-hooks-'))
  try {
    const config = join(root, '.claude')
    await mkdir(config)
    const script = 'let input="";process.stdin.on("data",x=>input+=x);process.stdin.on("end",()=>{const event=JSON.parse(input);require("node:fs").writeFileSync("observed.json",JSON.stringify({cwd:event.cwd,tool:event.tool_name}));process.stderr.write("blocked by test hook");process.exitCode=2})'
    const postScript = 'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(JSON.stringify({systemMessage:"post hook completed"})))'
    await writeFile(join(config, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Write', hooks: [
      { type: 'command', command: process.execPath, args: ['-e', script], timeout: 20 }
    ] }], PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: process.execPath, args: ['-e', postScript], timeout: 20 }] }] } }))
    const hooks = await createProjectHooks({ root, home: root, shell: process.execPath })
    assert.deepEqual(await hooks.dispatch({ hook_event_name: 'PreToolUse', tool_name: 'Read' }), {})
    const decision = await hooks.dispatch({ hook_event_name: 'PreToolUse', tool_name: 'Write' })
    assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny')
    assert.equal(decision.hookSpecificOutput.permissionDecisionReason, 'blocked by test hook')
    assert.deepEqual(await hooks.dispatch({ hook_event_name: 'PostToolUse', tool_name: 'Write' }), { systemMessage: 'post hook completed' })
    assert.deepEqual(JSON.parse(await readFile(join(root, 'observed.json'), 'utf8')), { cwd: await realpath(root), tool: 'Write' })
    await writeFile(join(config, 'settings.json'), JSON.stringify({ hooks: { SessionStart: [] } }))
    await assert.rejects(createProjectHooks({ root, home: root, shell: process.execPath }), /Unsupported project hook event/)
    await writeFile(join(config, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'http', url: 'https://example.invalid' }] }] } }))
    await assert.rejects(createProjectHooks({ root, home: root, shell: process.execPath }), /Unsupported project hook handler/)
    await writeFile(join(config, 'settings.json'), JSON.stringify({ permissions: { deny: ['Read'] } }))
    await assert.rejects(createProjectHooks({ root, home: root, shell: process.execPath }), /Project permission settings/)
    await writeFile(join(config, 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(npm test)'], additionalDirectories: ['/outside'] } }))
    await createProjectHooks({ root, home: root, shell: process.execPath })
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
    const hooks = await createProjectHooks({ root, home: root, shell: process.execPath })
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

test('terminates timed-out hook descendants before they can write', { timeout: 35000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-hooks-'))
  try {
    const config = join(root, '.claude')
    await mkdir(config)
    const descendant = 'setTimeout(()=>require("node:fs").writeFileSync("late-result","unexpected"),14000)'
    const script = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});require('node:fs').writeFileSync('child-ready','yes');setInterval(()=>{},1000)`
    await writeFile(join(config, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [
      { type: 'command', command: process.execPath, args: ['-e', script], timeout: 10 }
    ] }] } }))
    const hooks = await createProjectHooks({ root, home: root, shell: process.execPath })
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
    const hooks = await createProjectHooks({ root, home: root, shell: process.execPath })
    const started = Date.now()
    const decision = await hooks.dispatch({ hook_event_name: 'PreToolUse', tool_name: 'Write' })
    assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny')
    assert.equal(await readFile(join(root, 'allow.txt'), 'utf8'), 'x')
    assert.equal(await readFile(join(root, 'deny.txt'), 'utf8'), 'x')
    assert.ok(Date.now() - started < 5000)
    const unsupported = { type: 'command', command: process.execPath, args: ['-e',
      `process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{file_path:'elsewhere'}}}))`] }
    await writeFile(join(config, 'settings.local.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Write', hooks: [unsupported] }] } }))
    await assert.rejects((await createProjectHooks({ root, home: root, shell: process.execPath })).dispatch({ hook_event_name: 'PreToolUse', tool_name: 'Write' }), /Combining these project hook outputs/)
  } finally {
    const actual = await realpath(root)
    const local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-hooks-')) await rm(actual, { recursive: true, force: true })
  }
})


test('dispatches Stop decisions and matches Notification types locally', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-hooks-'))
  try {
    await mkdir(join(root, '.claude'))
    const command = (script) => ({ type: 'command', command: process.execPath, args: ['-e', script] })
    const stop = command('process.stdin.resume();process.stdin.on("end",()=>{process.stderr.write("continue work");process.exitCode=2})')
    const notify = command('let x="";process.stdin.on("data",c=>x+=c);process.stdin.on("end",()=>require("node:fs").writeFileSync("notification.json",x))')
    await writeFile(join(root, '.claude', 'settings.json'), JSON.stringify({ hooks: {
      Stop: [{ hooks: [stop] }], Notification: [{ matcher: '^permission_prompt$', hooks: [notify] }]
    } }))
    const hooks = await createProjectHooks({ root, home: root, shell: process.execPath })
    assert.deepEqual(await hooks.dispatch({ hook_event_name: 'Stop', stop_hook_active: false }), { decision: 'block', reason: 'continue work' })
    assert.deepEqual(await hooks.dispatch({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'idle' }), {})
    await hooks.dispatch({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'permission' })
    assert.equal(JSON.parse(await readFile(join(root, 'notification.json'), 'utf8')).notification_type, 'permission_prompt')
    await assert.rejects(hooks.dispatch({ hook_event_name: 'Stop' }), /Unsupported project hook event/)
  } finally {
    const actual = await realpath(root), local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-hooks-')) await rm(actual, { recursive: true, force: true })
  }
})


test('validates and supplies the supported global Claude settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-hooks-'))
  try {
    await mkdir(join(root, '.claude'))
    const settings = { effortLevel: 'high', env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }, hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: process.execPath, args: ['-e', 'process.stdout.write("ENV="+process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC)'] }] }] } }
    await writeFile(join(root, '.claude', 'settings.json'), JSON.stringify(settings))
    const hooks = await createProjectHooks({ root, home: root, shell: process.execPath })
    assert.deepEqual(hooks.controllerSettings(), { effortLevel: 'high', env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } })
    assert.equal((await hooks.dispatch({ hook_event_name: 'UserPromptSubmit', prompt: 'test' })).hookSpecificOutput.additionalContext, 'ENV=1')
    settings.env = { HTTP_PROXY: 'synthetic-secret', HTTPS_PROXY: 'synthetic-secret' }
    await writeFile(join(root, '.claude', 'settings.json'), JSON.stringify(settings))
    await assert.rejects(createProjectHooks({ root, home: root, shell: process.execPath }), error => /proxy settings/.test(error.message) && !error.message.includes('synthetic-secret'))
    settings.env = { UNKNOWN_SECRET_NAME: 'synthetic-secret' }
    await writeFile(join(root, '.claude', 'settings.json'), JSON.stringify(settings))
    await assert.rejects(createProjectHooks({ root, home: root, shell: process.execPath }), error => !error.message.includes('synthetic-secret'))
  } finally {
    const actual = await realpath(root), local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-hooks-')) await rm(actual, { recursive: true, force: true })
  }
})
