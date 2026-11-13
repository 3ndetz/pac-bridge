import { open, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { spawnContained, stopContained } from './spawn-contained.mjs'

const supportedEvents = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit'])

export async function createProjectHooks({ root, shell, home = homedir(), maxOutputBytes = 1024 * 1024 }) {
  if (!isAbsolute(root) || typeof shell !== 'string' || !shell || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) throw new Error('Invalid project hook configuration')
  const workspace = await realpath(root)
  const hooks = new Map()
  // ~/.claude/settings.json is Claude Code's global configuration, not an
  // OpenCode project setting. Project-local settings still require validation.
  const isHome = workspace === await realpath(home)
  for (const name of ['settings.json', 'settings.local.json']) {
    if (isHome && name === 'settings.json') continue
    const path = join(workspace, '.claude', name)
    let file
    try {
      const actual = await realpath(path)
      const local = relative(workspace, actual)
      if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error('Project hook settings resolve outside the workspace')
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
    const settings = JSON.parse(file)
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid project settings')
    if (Object.keys(settings).some((key) => !['hooks', 'permissions'].includes(key))) throw new Error('Project settings other than hooks are not yet supported')
    // Ignore only grants that would make the policy more permissive: the PAC
    // bridge continues asking HAPI for approval and remains confined to the
    // workspace. Never ignore deny, ask, or unknown permission settings.
    if (settings.permissions !== undefined) {
      const permissions = settings.permissions
      if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions) ||
          Object.keys(permissions).some((key) => !['allow', 'additionalDirectories'].includes(key)) ||
          Object.values(permissions).some((value) => !Array.isArray(value) || value.some((item) => typeof item !== 'string'))) {
        throw new Error('Project permission settings are not yet supported')
      }
    }
    if (settings.hooks === undefined) continue
    if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) throw new Error('Invalid project hooks')
    for (const [event, groups] of Object.entries(settings.hooks)) {
      if (!supportedEvents.has(event) || !Array.isArray(groups)) throw new Error(`Unsupported project hook event: ${event}`)
      for (const group of groups) {
        if (!group || typeof group !== 'object' || Object.keys(group).some((key) => !['matcher', 'hooks'].includes(key)) ||
            (group.matcher !== undefined && typeof group.matcher !== 'string') || !Array.isArray(group.hooks)) throw new Error('Unsupported project hook matcher')
        if (event === 'UserPromptSubmit' && group.matcher) throw new Error('UserPromptSubmit hook matchers are not supported')
        let matcher
        try { matcher = group.matcher ? new RegExp(group.matcher) : null } catch { throw new Error('Invalid project hook matcher') }
        for (const hook of group.hooks) {
          if (!hook || hook.type !== 'command' || typeof hook.command !== 'string' || !hook.command ||
              Object.keys(hook).some((key) => !['type', 'command', 'args', 'timeout'].includes(key)) ||
              (hook.args !== undefined && (!Array.isArray(hook.args) || hook.args.some((arg) => typeof arg !== 'string'))) ||
              (hook.timeout !== undefined && (!Number.isSafeInteger(hook.timeout) || hook.timeout < 1 || hook.timeout > 120))) {
            throw new Error('Unsupported project hook handler')
          }
          const entries = hooks.get(event) || []
          entries.push({ matcher, hook })
          hooks.set(event, entries)
        }
      }
    }
  }

  async function execute(hook, input) {
    const substitute = (value) => value.replaceAll('${CLAUDE_PROJECT_DIR}', workspace)
    const command = hook.args === undefined ? shell : substitute(hook.command)
    const args = hook.args === undefined ? ['-c', hook.command] : hook.args.map(substitute)
    const child = spawnContained(command, args, { cwd: workspace, env: { ...process.env, CLAUDE_PROJECT_DIR: workspace },
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = '', stderr = '', exceeded = false, timedOut = false
    function stop() {
      stopContained(child)
    }
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
      const timer = setTimeout(() => { timedOut = true; stop() }, (hook.timeout || 30) * 1000)
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }) })
    })
    if (timedOut || exceeded || result.signal) throw new Error('Project hook exceeded its execution limits')
    if (result.code === 2 && input.hook_event_name === 'PreToolUse') return { hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: stderr.trim() || 'Project hook denied the operation'
    } }
    if (result.code === 2 && input.hook_event_name === 'UserPromptSubmit') return { decision: 'block', reason: stderr.trim() || 'Project hook blocked the prompt' }
    if (result.code !== 0) throw new Error(`Project hook failed with exit code ${result.code}: ${stderr.trim()}`)
    if (!stdout.trim()) return {}
    let output
    try { output = JSON.parse(stdout) } catch {
      if (input.hook_event_name === 'UserPromptSubmit') return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: stdout.trim() } }
      throw new Error('Project hook returned unsupported non-JSON output')
    }
    if (!output || typeof output !== 'object' || Array.isArray(output)) throw new Error('Invalid project hook output')
    return output
  }

  return {
    async dispatch(input) {
      if (!input || !supportedEvents.has(input.hook_event_name) || (input.hook_event_name === 'UserPromptSubmit' ? typeof input.prompt !== 'string' : typeof input.tool_name !== 'string')) throw new Error('Unsupported project hook event')
      const matching = (hooks.get(input.hook_event_name) || []).filter((entry) => !entry.matcher || entry.matcher.test(input.tool_name))
      const unique = [...new Map(matching.map(({ hook }) => [JSON.stringify([hook.type, hook.command, hook.args ?? null, hook.timeout ?? null]), hook])).values()]
      if (!unique.length) return {}
      if (unique.length === 1) return execute(unique[0], input)
      const results = await Promise.allSettled(unique.map((hook) => execute(hook, input)))
      const failure = results.find((result) => result.status === 'rejected')
      if (failure) throw failure.reason
      const outputs = results.map((result) => result.value).filter((output) => Object.keys(output).length)
      if (!outputs.length) return {}
      if (outputs.length === 1) return outputs[0]
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
