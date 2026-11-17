import { open, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { spawnContained, stopContained, confirmContainedExit } from './spawn-contained.mjs'
import { permitsModelSwitchSetting } from './claude-settings-policy.mjs'

const supportedEvents = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Stop', 'Notification'])

export async function createProjectHooks({ root, shell, home = homedir(), maxOutputBytes = 1024 * 1024, asyncHooks, spawn = spawnContained }) {
  if (typeof spawn !== 'function' || !isAbsolute(root) || typeof shell !== 'string' || !shell || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) throw new Error('Invalid project hook configuration')
  const workspace = await realpath(root)
  const hooks = new Map()
  const controllerSettings = {}
  const hookEnvironment = {}
  const homeDir = await realpath(home)
  const sources = [
    { base: homeDir, name: 'settings.json', global: true },
    { base: workspace, name: 'settings.json', global: false },
    { base: workspace, name: 'settings.local.json', global: false },
  ]
  if (workspace === homeDir) sources.splice(1, 1)
  for (const { base, name, global } of sources) {
    const path = join(base, '.claude', name)
    let file
    try {
      const actual = await realpath(path)
      const local = relative(base, actual)
      if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error('Hook settings resolve outside their configuration root')
      const handle = await open(actual, 'r')
      try {
        const bytes = Buffer.alloc(maxOutputBytes + 1)
        let offset = 0
        while (offset < bytes.length) {
          const result = await handle.read(bytes, offset, bytes.length - offset, offset)
          if (!result.bytesRead) break
          offset += result.bytesRead
        }
        if (offset > maxOutputBytes) throw new Error('Project hook settings exceed the size limit')
        file = new TextDecoder('utf8', { fatal: true }).decode(bytes.subarray(0, offset))
      } finally { await handle.close() }
    } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    let settings
    try { settings = JSON.parse(file) } catch { throw new Error('Invalid hook settings JSON') }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid project settings')
    if (Object.keys(settings).some((key) => !['hooks', 'permissions', ...(global ? ['theme', 'autoUpdatesChannel', 'env', 'skipDangerousModePermissionPrompt', 'effortLevel', 'switchModelsOnFlag'] : [])].includes(key))) throw new Error('Project settings other than hooks are not yet supported')
    if (global && ((settings.theme !== undefined && typeof settings.theme !== 'string') ||
        (settings.autoUpdatesChannel !== undefined && !['stable', 'latest'].includes(settings.autoUpdatesChannel)))) {
      throw new Error('Invalid global Claude preference')
    }
    if (global && settings.skipDangerousModePermissionPrompt !== undefined && typeof settings.skipDangerousModePermissionPrompt !== 'boolean') throw new Error('Invalid global Claude preference')
    if (global && settings.effortLevel !== undefined) {
      if (!['low', 'medium', 'high', 'xhigh'].includes(settings.effortLevel)) throw new Error('Unsupported global Claude effort setting')
      controllerSettings.effortLevel = settings.effortLevel
    }
    if (global && settings.switchModelsOnFlag !== undefined) {
      if (!permitsModelSwitchSetting(settings.switchModelsOnFlag)) throw new Error('Unsupported global Claude fallback setting')
      controllerSettings.switchModelsOnFlag = settings.switchModelsOnFlag
    }
    if (global && settings.env !== undefined) {
      if (settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env) && ['HTTP_PROXY', 'HTTPS_PROXY'].some(key => Object.hasOwn(settings.env, key))) throw new Error('Global Claude proxy settings require unsupported controller configuration')
      if (!settings.env || typeof settings.env !== 'object' || Array.isArray(settings.env) ||
          Object.entries(settings.env).some(([key, value]) => key !== 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC' || value !== '1')) {
        throw new Error('Global Claude environment settings are not yet supported')
      }
      if (Object.keys(settings.env).length) {
        controllerSettings.env = { ...settings.env }
        Object.assign(hookEnvironment, settings.env)
      }
    }
    // Ignore only grants that would make the policy more permissive: the PAC
    // bridge continues asking HAPI for approval and remains confined to the
    // workspace. Never ignore deny, ask, or unknown permission settings.
    if (settings.permissions !== undefined) {
      const permissions = settings.permissions
      if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions) ||
          Object.keys(permissions).some((key) => !['allow', 'additionalDirectories', 'defaultMode'].includes(key)) ||
          ['allow', 'additionalDirectories'].some((key) => permissions[key] !== undefined && (!Array.isArray(permissions[key]) || permissions[key].some((item) => typeof item !== 'string'))) ||
          (permissions.defaultMode !== undefined && !['default', 'acceptEdits', 'bypassPermissions'].includes(permissions.defaultMode))) {
        throw new Error('Project permission settings are not yet supported')
      }
    }
    if (settings.hooks === undefined) continue
    if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) throw new Error('Invalid project hooks')
    for (const [event, groups] of Object.entries(settings.hooks)) {
      if (!supportedEvents.has(event) || !Array.isArray(groups)) throw new Error('Unsupported project hook event')
      for (const group of groups) {
        if (!group || typeof group !== 'object' || Object.keys(group).some((key) => !['matcher', 'hooks'].includes(key)) ||
            (group.matcher !== undefined && typeof group.matcher !== 'string') || !Array.isArray(group.hooks)) throw new Error('Unsupported project hook matcher')
        if (['UserPromptSubmit', 'Stop'].includes(event) && group.matcher) throw new Error('UserPromptSubmit hook matchers are not supported')
        let matcher
        try { matcher = group.matcher ? new RegExp(group.matcher) : null } catch { throw new Error('Invalid project hook matcher') }
        for (const hook of group.hooks) {
          if (!hook || hook.type !== 'command' || typeof hook.command !== 'string' || !hook.command ||
              Object.keys(hook).some((key) => !['type', 'command', 'args', 'timeout', 'async'].includes(key)) ||
              (hook.args !== undefined && (!Array.isArray(hook.args) || hook.args.some((arg) => typeof arg !== 'string'))) ||
              (hook.timeout !== undefined && (!Number.isSafeInteger(hook.timeout) || hook.timeout < 1 || hook.timeout > 120)) ||
              (hook.async !== undefined && hook.async !== false && !(hook.async === true && process.env.PAC_TEST_ASYNC_HOOKS === '1'))) {
            throw new Error('Unsupported project hook handler')
          }
          const entries = hooks.get(event) || []
          entries.push({ matcher, hook })
          hooks.set(event, entries)
        }
      }
    }
  }

  async function execute(hook, input, registerStop) {
    const substitute = (value) => value.replaceAll('${CLAUDE_PROJECT_DIR}', workspace)
    const command = hook.args === undefined ? shell : substitute(hook.command)
    const args = hook.args === undefined ? ['-c', hook.command] : hook.args.map(substitute)
    const child = spawn(command, args, { cwd: workspace, env: { ...process.env, ...hookEnvironment, CLAUDE_PROJECT_DIR: workspace },
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = '', stderr = '', exceeded = false, timedOut = false
    function stop() {
      stopContained(child)
    }
    registerStop?.(stop)
    function append(current, chunk) {
      const next = current + chunk.toString('utf8')
      if (Buffer.byteLength(next, 'utf8') > maxOutputBytes) { exceeded = true; stop(); return current }
      return next
    }
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk) })
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk) })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify({ ...input, cwd: workspace }))
    const result = await new Promise((resolve, reject) => {
      const timer = registerStop ? null : setTimeout(() => { timedOut = true; stop() }, (hook.timeout || 30) * 1000)
      child.once('error', () => { clearTimeout(timer); reject(new Error('Project hook could not be started')) })
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }) })
    })
    await confirmContainedExit(child)
    if (timedOut || exceeded || result.signal) throw new Error('Project hook exceeded its execution limits')
    if (registerStop && result.code !== 0) return {}
    if (result.code === 2 && input.hook_event_name === 'PreToolUse') return { hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: stderr.trim() || 'Project hook denied the operation'
    } }
    if (result.code === 2 && ['UserPromptSubmit', 'Stop'].includes(input.hook_event_name)) return { decision: 'block', reason: stderr.trim() || 'Project hook blocked the prompt' }
    if (result.code !== 0) throw new Error(`Project hook failed with exit code ${result.code}`)
    if (!stdout.trim()) return {}
    let output
    try { output = JSON.parse(stdout) } catch {
      if (registerStop) {
        const candidates = stdout.split(/\r?\n/).flatMap(line => {
          try { const value = JSON.parse(line); return value && typeof value === 'object' && !Array.isArray(value) ? [value] : [] } catch { return [] }
        })
        if (candidates.length !== 1) return {}
        output = candidates[0]
      } else {
        if (input.hook_event_name === 'Notification') return {}
        if (input.hook_event_name === 'UserPromptSubmit') return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: stdout.trim() } }
        throw new Error('Project hook returned unsupported non-JSON output')
      }
    }
    if (!output || typeof output !== 'object' || Array.isArray(output)) throw new Error('Invalid project hook output')
    return output
  }

  return {
    hasAsyncHooks() { return [...hooks.values()].some(entries => entries.some(entry => entry.hook.async === true)) },
    controllerSettings() { return structuredClone(controllerSettings) },
    hasEvent(event) { return (hooks.get(event) || []).length > 0 },
    async dispatch(input) {
      if (!input || !supportedEvents.has(input.hook_event_name) || (input.hook_event_name === 'UserPromptSubmit' ? typeof input.prompt !== 'string' : input.hook_event_name === 'Stop' ? typeof input.stop_hook_active !== 'boolean' : input.hook_event_name === 'Notification' ? typeof input.notification_type !== 'string' || typeof input.message !== 'string' : typeof input.tool_name !== 'string')) throw new Error('Unsupported project hook event')
      const matching = (hooks.get(input.hook_event_name) || []).filter((entry) => !entry.matcher || entry.matcher.test(input.hook_event_name === 'Notification' ? input.notification_type : input.tool_name))
      const unique = [...new Map(matching.map(({ hook }) => [JSON.stringify([hook.type, hook.command, hook.args ?? null, hook.timeout ?? null, hook.async === true]), hook])).values()]
      const deferred = input.hook_event_name === 'UserPromptSubmit' ? asyncHooks?.drain() || [] : []
      const asyncEntries = unique.filter(hook => hook.async === true)
      if (asyncEntries.length && !asyncHooks) throw new Error('Async source hooks are unavailable')
      if (asyncEntries.length) asyncHooks.ensureCapacity(asyncEntries.length)
      for (const hook of asyncEntries) asyncHooks.submit(registerStop => execute(hook, input, registerStop))
      const synchronous = unique.filter(hook => hook.async !== true)
      if (deferred.length) synchronous.push(null)
      if (!synchronous.length) return {}
      const run = hook => hook ? execute(hook, input) : Promise.resolve({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: deferred.join('\n\n') } })
      if (synchronous.length === 1 && !['Stop', 'Notification'].includes(input.hook_event_name)) return run(synchronous[0])
      const results = await Promise.allSettled(synchronous.map(run))
      const failure = results.find((result) => result.status === 'rejected')
      if (failure) throw failure.reason
      const outputs = results.map((result) => result.value).filter((output) => Object.keys(output).length)
      if (!outputs.length) return {}
      if (outputs.length === 1 && !['Stop', 'Notification'].includes(input.hook_event_name)) return outputs[0]
      if (input.hook_event_name === 'Notification') {
        if (outputs.some((output) => Object.keys(output).length)) throw new Error('Combining notification hook outputs is not yet supported')
        return {}
      }
      if (input.hook_event_name === 'Stop') {
        const reasons = []
        for (const output of outputs) {
          if (Object.keys(output).some((key) => !['decision', 'reason'].includes(key)) ||
              (output.decision !== undefined && output.decision !== 'block') ||
              (output.reason !== undefined && typeof output.reason !== 'string')) throw new Error('Combining stop hook outputs is not yet supported')
          if (output.decision === 'block') reasons.push(output.reason || 'Project hook blocked completion')
        }
        return reasons.length ? { decision: 'block', reason: reasons.join('\n') } : {}
      }
      if (input.hook_event_name === 'UserPromptSubmit') {
        const contexts = [], reasons = []
        for (const output of outputs) {
          const specific = output.hookSpecificOutput
          if (Object.keys(output).some((key) => !['decision', 'reason', 'hookSpecificOutput'].includes(key)) ||
              (output.decision !== undefined && output.decision !== 'block') ||
              (output.reason !== undefined && typeof output.reason !== 'string') ||
              (specific !== undefined && (!specific || specific.hookEventName !== 'UserPromptSubmit' ||
                Object.keys(specific).some((key) => !['hookEventName', 'additionalContext'].includes(key)) ||
                (specific.additionalContext !== undefined && typeof specific.additionalContext !== 'string')))) {
            throw new Error('Combining these project hook outputs is not yet supported')
          }
          if (output.decision === 'block') reasons.push(output.reason || 'Project hook blocked the prompt')
          if (specific?.additionalContext) contexts.push(specific.additionalContext)
        }
        return { ...(reasons.length ? { decision: 'block', reason: reasons.join('\n') } : {}),
          ...(contexts.length ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: contexts.join('\n\n') } } : {}) }
      }
      const priority = { allow: 1, ask: 2, deny: 3 }
      let selected
      for (const output of outputs) {
        const decision = output.hookSpecificOutput
        if (input.hook_event_name !== 'PreToolUse' || Object.keys(output).some((key) => key !== 'hookSpecificOutput') ||
            !decision || decision.hookEventName !== 'PreToolUse' || !Object.hasOwn(priority, decision.permissionDecision) ||
            Object.keys(decision).some((key) => !['hookEventName', 'permissionDecision', 'permissionDecisionReason'].includes(key))) {
          throw new Error('Combining these project hook outputs is not yet supported')
        }
        if (!selected || priority[decision.permissionDecision] > priority[selected.permissionDecision]) selected = decision
      }
      return { hookSpecificOutput: selected }
    },
  }
}
