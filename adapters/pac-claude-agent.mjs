import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { prototypeToolDecision } from '../src/tool-policy.mjs'
import { mapQuestionAnswers } from '../src/question-answers.mjs'
import { startTerminalOutputPump } from '../src/terminal-stream.mjs'
import { waitForTerminal } from '../src/terminal-wait.mjs'
import { stopNativeTask } from '../src/native-task-stop.mjs'

// Windows' abbreviated 8.3 paths can crash Node's directory watcher when a
// notification arrives with the long path. Preserve the target, including a
// not-yet-created suffix, while expanding any existing ancestor.
function expandWindowsPath(value) {
  if (process.platform !== 'win32' || typeof value !== 'string' || !isAbsolute(value)) return value
  let ancestor = value
  const suffix = []
  while (true) {
    try { return join(realpathSync.native(ancestor), ...suffix) } catch {
      const parent = dirname(ancestor)
      if (parent === ancestor) return value
      suffix.unshift(ancestor.slice(parent.length).replace(/^[\\/]+/, ''))
      ancestor = parent
    }
  }
}
if (process.platform === 'win32') {
  for (const name of ['CLAUDE_CONFIG_DIR', 'HOME', 'USERPROFILE', 'TEMP', 'TMP']) {
    if (process.env[name]) process.env[name] = expandWindowsPath(process.env[name])
  }
}

const [sdkRoot] = process.argv.slice(2)
const require = createRequire(sdkRoot ? join(sdkRoot, 'package.json') : fileURLToPath(new URL('../package.json', import.meta.url)))
const acp = await import(pathToFileURL(require.resolve('@agentclientprotocol/claude-agent-acp/dist/acp-agent.js')).href)
const utils = await import(pathToFileURL(require.resolve('@agentclientprotocol/claude-agent-acp/dist/utils.js')).href)
const { ndJsonStream, methods } = await import(pathToFileURL(require.resolve('@agentclientprotocol/sdk')).href)
const { createSdkMcpServer, tool } = await import(pathToFileURL(require.resolve('@anthropic-ai/claude-agent-sdk')).href)
const { z } = require('zod')
const questionsEnabled = process.env.PAC_ENABLE_QUESTIONS === '1' || process.env.PAC_TEST_QUESTIONS === '1'
const backgroundEnabled = process.env.PAC_ENABLE_BACKGROUND === '1' || process.env.PAC_TEST_BACKGROUND === '1'
const hooksEnabled = process.env.PAC_ENABLE_PROJECT_HOOKS === '1' || process.env.PAC_TEST_PROJECT_HOOKS === '1'
const streamingEnabled = process.env.PAC_ENABLE_SHELL_STREAMING === '1' || process.env.PAC_TEST_STREAM_SHELL === '1'
console.log = console.error
console.info = console.error
console.warn = console.error

let activeAgent
const app = acp.v1AgentApp(undefined, (agent) => {
  activeAgent = agent
  const backgroundCalls = new Map()
  const publish = agent.client.sessionUpdate.bind(agent.client)
  agent.client.sessionUpdate = async (notification) => {
    const update = notification.update
    if (update?.sessionUpdate === 'subagent_spawned') {
      const taskId = update.subagentSessionId
      const taskMap = agent.sessions[notification.sessionId]?.nativeSubagentTaskIdByToolUseId
      const match = taskMap && [...taskMap.entries()].find(([, id]) => id === taskId || taskId.startsWith(`${id}:generation:`))
      if (match && backgroundCalls.has(match[0])) notification = { ...notification, update: { ...update,
        _meta: { ...update._meta, pacBridge: { background: backgroundCalls.get(match[0]), toolUseId: match[0] } } } }
    }
    return publish(notification)
  }
  const originalNew = agent.newSession.bind(agent)
  const originalLoad = agent.loadSession.bind(agent)
  async function prepareSession(params, loading) {
    params = { ...params, cwd: expandWindowsPath(params.cwd) }
    let sessionId = loading ? params.sessionId : undefined
    async function writeSource(path, content, signal) {
      if (signal?.aborted) throw new Error('PAC write cancelled before it started')
      const operationId = randomUUID()
      const cancel = () => { void agent.client.inner.ctx.request('pac/fs/cancel_write', { sessionId, operationId }).catch(() => {}) }
      signal?.addEventListener('abort', cancel, { once: true })
      try {
        const result = await agent.client.inner.ctx.request('pac/fs/write', { sessionId, operationId, path, content })
        if (signal?.aborted) throw new Error('PAC write cancelled; its outcome may be unknown')
        return result
      } finally { signal?.removeEventListener('abort', cancel) }
    }
    const server = createSdkMcpServer({ name: 'pac', version: '1.0.0', tools: [
      tool('Read', 'Read a text file from the client workspace.', {
        file_path: z.string(), offset: z.number().int().positive().optional(), limit: z.number().int().positive().optional(),
      }, async (input) => {
        if (process.env.PAC_TEST_BACKGROUND_DELAY === '1' && input.file_path.endsWith('background.txt')) await new Promise((resolve) => setTimeout(resolve, 8000))
        if (/\.(png|jpe?g|gif|webp)$/i.test(input.file_path)) {
          if (input.offset || input.limit) throw new Error('Line ranges are not supported for image reads')
          const image = await agent.client.inner.ctx.request('pac/fs/read_image', { sessionId, path: input.file_path })
          return { content: [{ type: 'image', data: image.data, mimeType: image.mimeType }] }
        }
        const response = await agent.readTextFile({ sessionId, path: input.file_path, ...(input.offset ? { line: input.offset } : {}), ...(input.limit ? { limit: input.limit } : {}) })
        return { content: [{ type: 'text', text: response.content }] }
      }),
      tool('Write', 'Write a text file in the client workspace.', { file_path: z.string(), content: z.string() }, async (input, extra) => {
        await writeSource(input.file_path, input.content, extra?.signal)
        return { content: [{ type: 'text', text: 'File written successfully.' }] }
      }),
      tool('Glob', 'Find source workspace files matching a glob pattern.', {
        pattern: z.string().min(1), path: z.string().optional(),
      }, async (input) => {
        const result = await agent.client.inner.ctx.request('pac/search/glob', { sessionId, ...input })
        return { content: [{ type: 'text', text: result.output || 'No files found.' }] }
      }),
      tool('Grep', 'Search source workspace files using a regular expression.', {
        pattern: z.string().min(1), path: z.string().optional(), glob: z.string().optional(),
        output_mode: z.enum(['files_with_matches', 'content', 'count']).optional(), '-i': z.boolean().optional(),
      }, async (input) => {
        const result = await agent.client.inner.ctx.request('pac/search/grep', { sessionId, pattern: input.pattern,
          ...(input.path ? { path: input.path } : {}), ...(input.glob ? { glob: input.glob } : {}),
          ...(input.output_mode ? { outputMode: input.output_mode } : {}), ...(input['-i'] === undefined ? {} : { ignoreCase: input['-i'] }) })
        return { content: [{ type: 'text', text: result.output || 'No matches found.' }] }
      }),
      tool('Skill', 'Invoke a listed skill from the source workspace.', { skill: z.string(), args: z.string().optional() }, async (input) => {
        const result = await agent.client.inner.ctx.request('pac/skills/invoke', { sessionId, name: input.skill, ...(input.args ? { args: input.args } : {}) })
        return { content: [{ type: 'text', text: result.content }] }
      }),
      tool('AskUserQuestion', 'Ask the user questions and wait for their answers.', {
        questions: z.array(z.object({ question: z.string().min(1), header: z.string(), multiSelect: z.boolean(),
          options: z.array(z.object({ label: z.string(), description: z.string() })).min(2).max(4) })).min(1).max(4),
      }, async (input, extra) => {
        if (!questionsEnabled) throw new Error('PAC interactive questions are disabled')
        const toolCallId = extra?._meta?.['claudecode/toolUseId']
        if (typeof toolCallId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(toolCallId)) throw new Error('PAC question has no valid originating tool identity')
        const session = agent.sessions[sessionId]
        const route = session?.nativeSubagentRuntime?.routeOfToolCall(toolCallId, session?.eagerToolCallSessions?.get(toolCallId))
        const children = session?.nativeSubagentRuntime?.children
        if (!route && children instanceof Map && [...children.values()].some((child) => child.terminalState === undefined)) throw new Error('PAC question owner cannot be determined while a subagent is active')
        const routed = route?.({ sessionId, update: { sessionUpdate: 'tool_call', toolCallId } })
        if (route && !routed) throw new Error('PAC question owner is no longer active')
        if (extra?.signal?.aborted) throw new Error('PAC question cancelled')
        const cancel = () => { void agent.client.inner.ctx.request('pac/questions/cancel', { sessionId, toolCallId }).catch(() => {}) }
        extra?.signal?.addEventListener('abort', cancel, { once: true })
        try {
          const response = await agent.client.inner.ctx.request('pac/questions/ask', { sessionId, toolCallId, ownerSessionId: routed?.sessionId || sessionId, questions: input.questions })
          if (extra?.signal?.aborted) throw new Error('PAC question cancelled')
          const answers = mapQuestionAnswers(input.questions, response.answers)
          return { content: [{ type: 'text', text: JSON.stringify({ questions: input.questions, answers }) }] }
        } finally {
          extra?.signal?.removeEventListener('abort', cancel)
        }
      }),
      tool('Edit', 'Replace exact text in a client workspace file.', {
        file_path: z.string(), old_string: z.string().min(1), new_string: z.string(), replace_all: z.boolean().optional(),
      }, async (input, extra) => {
        const response = await agent.readTextFile({ sessionId, path: input.file_path })
        const first = response.content.indexOf(input.old_string)
        if (first < 0) return { isError: true, content: [{ type: 'text', text: 'The old string was not found.' }] }
        if (!input.replace_all && response.content.indexOf(input.old_string, first + input.old_string.length) >= 0) {
          return { isError: true, content: [{ type: 'text', text: 'The old string is not unique.' }] }
        }
        const content = input.replace_all ? response.content.split(input.old_string).join(input.new_string)
          : response.content.slice(0, first) + input.new_string + response.content.slice(first + input.old_string.length)
        await writeSource(input.file_path, content, extra?.signal)
        return { content: [{ type: 'text', text: 'File edited successfully.' }] }
      }),
      tool('Bash', 'Execute a Bash command in the client workspace, optionally in the background.', {
        command: z.string(), description: z.string().optional(), timeout: z.number().int().positive().max(120000).optional(), run_in_background: z.boolean().optional(),
      }, async (input, extra) => {
        const cwd = params._meta?.pac?.workspaceCwd
        if (!cwd) throw new Error('The source workspace directory was not provided')
        const request = (method, values) => agent.client.inner.ctx.request(method, { sessionId, ...values })
        if (input.run_in_background) {
          if (extra?.signal?.aborted) throw new Error('Background command cancelled before creation')
          const operationId = randomUUID()
          const cancel = () => { void request('pac/terminal/cancel_create', { operationId }).catch(() => {}) }
          extra?.signal?.addEventListener('abort', cancel, { once: true })
          try {
            const task = await request('pac/terminal/start_background', { operationId, command: 'bash', args: ['-c', input.command], cwd,
              ...(input.description ? { description: input.description } : {}), ...(input.timeout ? { timeoutMs: input.timeout } : {}) })
            if (extra?.signal?.aborted) throw new Error('Background command cancelled; outcome may be unknown')
            return { content: [{ type: 'text', text: `Background shell task ${task.taskId} started. Use mcp__pac__TaskOutput or mcp__pac__TaskStop with this task ID.` }] }
          } finally { extra?.signal?.removeEventListener('abort', cancel) }
        }
        const operationId = randomUUID()
        let terminal
        let cancellation
        const abortCreate = () => { cancellation = request('pac/terminal/cancel_create', { operationId }).catch(() => {}) }
        if (extra?.signal?.aborted) throw new Error('Terminal command cancelled before creation')
        extra?.signal?.addEventListener('abort', abortCreate, { once: true })
        let pump
        try {
          if (extra?.signal?.aborted) throw new Error('Terminal command cancelled before creation')
          terminal = await request('pac/terminal/create', { operationId, command: 'bash', args: ['-c', input.command], cwd })
          if (extra?.signal?.aborted) throw new Error('Terminal command cancelled; outcome may be unknown')
          if (streamingEnabled) {
            const toolCallId = extra?._meta?.['claudecode/toolUseId']
            if (typeof toolCallId !== 'string' || !toolCallId) throw new Error('Shell output has no originating tool identity')
            pump = startTerminalOutputPump({ read: () => request(methods.client.terminal.output, { terminalId: terminal.terminalId }),
              emit: async (output) => {
                const current = agent.sessions[sessionId]
                const route = current?.nativeSubagentRuntime?.routeOfToolCall(toolCallId, current?.eagerToolCallSessions?.get(toolCallId))
                const children = current?.nativeSubagentRuntime?.children
                if (!route && children instanceof Map && [...children.values()].some((child) => child.terminalState === undefined)) throw new Error('Shell output owner cannot be determined')
                const notification = { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress',
                  _meta: { pacShellStream: { stdout: output.output, truncated: output.truncated } } } }
                const routed = route ? route(notification) : notification
                if (!routed) throw new Error('Shell output owner is no longer active')
                await agent.client.sessionUpdate(routed)
              } })
          }
          const status = await waitForTerminal({ wait: () => request(methods.client.terminal.waitForExit, { terminalId: terminal.terminalId }),
            timeoutMs: input.timeout || 120000, signal: extra?.signal })
          const output = await request(methods.client.terminal.output, { terminalId: terminal.terminalId })
          return { isError: status.exitCode !== 0, content: [{ type: 'text', text: `${output.output}\nExit code: ${status.exitCode ?? status.signal}` }] }
        } finally {
          extra?.signal?.removeEventListener('abort', abortCreate)
          try { if (pump) await pump.stop() } finally {
            if (terminal) await request(methods.client.terminal.release, { terminalId: terminal.terminalId })
            if (cancellation) await cancellation
          }
        }
      }),
      tool('TaskOutput', 'Get output and status of a PAC background shell task. This does not handle native subagent tasks.', {
        task_id: z.string(), block: z.boolean().optional(), timeout: z.number().int().positive().max(120000).optional(),
      }, async (input) => {
        const result = await agent.client.inner.ctx.request('pac/terminal/task_output', { sessionId, taskId: input.task_id,
          block: input.block ?? true, ...(input.timeout ? { timeoutMs: input.timeout } : {}) })
        return { isError: ['failed', 'timed_out'].includes(result.status), content: [{ type: 'text', text: JSON.stringify(result) }] }
      }),
      tool('TaskStop', 'Request cancellation of a PAC background shell task or native subagent.', { task_id: z.string() }, async (input) => {
        const result = input.task_id.startsWith('pac-shell-')
          ? await agent.client.inner.ctx.request('pac/terminal/task_stop', { sessionId, taskId: input.task_id })
          : await stopNativeTask(agent.sessions[sessionId], input.task_id)
        return { content: [{ type: 'text', text: JSON.stringify(result) }] }
      }),
    ] })
    const meta = params._meta || {}
    const skills = meta.pac?.skills || []
    const instructions = meta.pac?.instructions || []
    const loadedScopedRules = new Set()
    const scopedRulesHook = async (input) => {
      if (meta.pac?.scopedRules !== true) return {}
      const name = (input.tool_name || '').replace(/^mcp__pac__/, '')
      const target = ['Read', 'Write', 'Edit'].includes(name) && typeof input.tool_input?.file_path === 'string' ? { path: input.tool_input.file_path }
        : name === 'Bash' && !input.tool_input?.run_in_background && typeof input.tool_input?.command === 'string' ? { command: input.tool_input.command } : null
      if (!target) return {}
      const result = await agent.client.inner.ctx.request('pac/instructions/match', { sessionId, ...target })
      if (!Array.isArray(result?.instructions) || result.instructions.length > 256 || result.instructions.some((entry) => typeof entry?.path !== 'string' || typeof entry?.content !== 'string')) throw new Error('Invalid scoped instruction response')
      const next = result.instructions.filter((entry) => !loadedScopedRules.has(entry.path))
      if (!next.length) return {}
      const context = next.map((entry) => `Source instructions from ${JSON.stringify(entry.path)}:\n${entry.content}`).join('\n\n')
      if (context.length > 9000) throw new Error('Scoped instructions exceed the supported context size')
      for (const entry of next) loadedScopedRules.add(entry.path)
      return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } }
    }
    if (!Array.isArray(skills) || skills.length > 100 || skills.some((skill) => typeof skill?.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(skill.name) || typeof skill?.description !== 'string' || skill.description.length > 1536)) throw new Error('Invalid source skill catalog')
    if (!Array.isArray(instructions) || instructions.length > 256 || instructions.some((entry) => typeof entry?.path !== 'string' || typeof entry?.content !== 'string') ||
        Buffer.byteLength(JSON.stringify(instructions), 'utf8') > 1024 * 1024) throw new Error('Invalid source instructions')
    if (meta.systemPrompt !== undefined && typeof meta.systemPrompt !== 'string' &&
        (!meta.systemPrompt || typeof meta.systemPrompt !== 'object' || Array.isArray(meta.systemPrompt) ||
          (meta.systemPrompt.append !== undefined && typeof meta.systemPrompt.append !== 'string'))) throw new Error('Unsupported system prompt format')
    const skillPrompt = skills.length ? `Available source workspace skills; invoke them with the Skill tool: ${JSON.stringify(skills)}` : ''
    const instructionPrompt = instructions.map((entry) => `Source instructions from ${JSON.stringify(entry.path)}:\n${entry.content}`).join('\n\n')
    const sourcePrompt = [instructionPrompt, skillPrompt].filter(Boolean).join('\n\n')
    const systemPrompt = sourcePrompt ? typeof meta.systemPrompt === 'string' ? `${meta.systemPrompt}\n\n${sourcePrompt}` :
      { ...(meta.systemPrompt || {}), append: [meta.systemPrompt?.append, sourcePrompt].filter(Boolean).join('\n\n') } : meta.systemPrompt
    const claudeCode = meta.claudeCode || {}
    const options = claudeCode.options || {}
    if (options.mcpServers && Object.hasOwn(options.mcpServers, 'pac')) throw new Error('The pac MCP server name is reserved by the bridge')
    if (process.env.PAC_TEST_SOURCE_MCP === '1' && options.mcpServers && Object.hasOwn(options.mcpServers, 'source_tools')) throw new Error('The source_tools MCP server name is reserved by the bridge')
    if (sourcePrompt && options.systemPrompt !== undefined) throw new Error('Source instructions with an SDK-level custom system prompt are not yet supported')
    const aliases = process.env.PAC_USE_ALIASES !== '0'
    const projectHook = async (input) => {
      if (!hooksEnabled) return {}
      const toolName = typeof input.tool_name === 'string' ? input.tool_name.replace(/^mcp__pac__/, '') : input.tool_name
      try {
        return await agent.client.inner.ctx.request('pac/hooks/dispatch', { sessionId, input: { ...input, tool_name: toolName } })
      } catch (error) {
        if (input.hook_event_name !== 'PreToolUse') throw error
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
          permissionDecisionReason: `Source project hook failed: ${error.message}` } }
      }
    }
    const opened = await (loading ? originalLoad : originalNew)({ ...params, _meta: { ...meta, ...(systemPrompt ? { systemPrompt } : {}), claudeCode: { ...claudeCode, options: {
      ...options, tools: aliases ? { type: 'preset', preset: 'claude_code' } : [], mcpServers: { ...(options.mcpServers || {}), pac: server,
        ...(process.env.PAC_TEST_SOURCE_MCP === '1' ? { source_tools: { type: 'stdio', command: process.execPath,
          args: [fileURLToPath(new URL('./pac-acp-source.mjs', import.meta.url)), 'testmcp', process.env.PAC_TEST_MCP_URL, process.env.PAC_TEST_MCP_TOKEN_FILE] } } : {}) },
      allowedTools: aliases ? ['mcp__pac__Read', 'mcp__pac__Write', 'mcp__pac__Edit', 'mcp__pac__Bash', 'mcp__pac__Glob', 'mcp__pac__Grep', 'mcp__pac__Skill', 'mcp__pac__AskUserQuestion', 'mcp__pac__TaskOutput', 'mcp__pac__TaskStop'] : ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Skill', 'AskUserQuestion', 'TaskOutput', 'TaskStop'],
      ...(aliases ? { toolAliases: { Read: 'mcp__pac__Read', Write: 'mcp__pac__Write', Edit: 'mcp__pac__Edit', Bash: 'mcp__pac__Bash', Glob: 'mcp__pac__Glob', Grep: 'mcp__pac__Grep', Skill: 'mcp__pac__Skill', AskUserQuestion: 'mcp__pac__AskUserQuestion' },
        disallowedTools: ['PowerShell', 'NotebookEdit', 'WebFetch', 'WebSearch',
          ...(backgroundEnabled ? [] : ['Agent', 'Task', 'TaskOutput', 'TaskStop'])] } : {}),
      hooks: { ...options.hooks, PostToolUse: [...(options.hooks?.PostToolUse || []), { hooks: [projectHook, scopedRulesHook] }],
        PostToolUseFailure: [...(options.hooks?.PostToolUseFailure || []), { hooks: [projectHook] }],
        PreToolUse: [...(options.hooks?.PreToolUse || []), { hooks: [projectHook], onFailure: 'block' }, { hooks: [async (input) => {
        return prototypeToolDecision(input.tool_name, { aliases, allowSubagents: backgroundEnabled, allowQuestions: questionsEnabled,
          allowSourceMcp: process.env.PAC_TEST_SOURCE_MCP === '1' })
      }] }, { matcher: 'Agent|Task', hooks: [async (input, toolUseId) => {
        if (toolUseId) backgroundCalls.set(toolUseId, input.tool_input?.run_in_background === true)
        await agent.client.sessionUpdate({ sessionId, update: { sessionUpdate: 'session_info_update', _meta: { pacProbe: { background: input.tool_input?.run_in_background === true } } } })
        return {}
      }] }] },
      forwardSubagentText: true, settingSources: [],
    } } } })
    sessionId = opened.sessionId || sessionId
    return opened
  }
  agent.newSession = (params) => prepareSession(params, false)
  agent.loadSession = (params) => prepareSession(params, true)
})
const extendedApp = app.onRequest('pac/tasks/stop_native', { parse: (params) => {
  if (!params || typeof params.sessionId !== 'string' || typeof params.taskId !== 'string' || !params.taskId) throw new Error('Invalid native task stop request')
  return params
} }, async ({ params }) => stopNativeTask(activeAgent.sessions[params.sessionId], params.taskId))
const connection = extendedApp.connect(ndJsonStream(utils.nodeToWebWritable(process.stdout), utils.nodeToWebReadable(process.stdin)))
connection.closed.finally(async () => { await activeAgent?.dispose(); process.exit(0) })
process.stdin.resume()
