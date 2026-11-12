import { spawnContained, stopContained } from '../src/spawn-contained.mjs'
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { Duplex } from 'node:stream'
import { createAcpPeer } from '../src/acp-peer.mjs'
import { connectSource } from '../src/acp-transport.mjs'
import { createWorkspace } from '../src/acp-workspace.mjs'
import { authorizedWrite } from '../src/authorized-write.mjs'
import { openPacSession } from '../src/pac-session.mjs'
import { createSubagentTranslator } from '../src/subagent-events.mjs'
import { createTerminalManager } from '../src/acp-terminal.mjs'
import { createSearch } from '../src/acp-search.mjs'
import { createSessionStore } from '../src/session-store.mjs'
import { createProjectHooks } from '../src/project-hooks.mjs'
import { createBackgroundTerminal } from '../src/background-terminal.mjs'
import { createSourceSkills } from '../src/source-skills.mjs'
import { readSourceInstructions } from '../src/source-instructions.mjs'
import { matchesProjectRule, simpleBashReadPath } from '../src/scoped-rules.mjs'
import { assertNoUnsupportedOpenCodePlugins } from '../src/opencode-plugin-guard.mjs'
import { notifyTurnComplete } from '../src/completion-notifier.mjs'

const { PAC_OPENCODE_BINARY: binary, PAC_RELAY_URL: url, PAC_NAME: name, PAC_SOURCE_TOKEN_FILE: tokenFile, PAC_CONTROLLER_CWD: remoteCwd } = process.env
if (process.env.PAC_EXPERIMENTAL !== '1' || !binary) throw new Error('Incomplete experimental OpenCode router configuration')
const records = process.env.PAC_ENDPOINTS_FILE ? JSON.parse(await readFile(process.env.PAC_ENDPOINTS_FILE, 'utf8')) : [{ id: name, name, displayName: process.env.PAC_DISPLAY_NAME, modelPrefix: process.env.PAC_MODEL_PREFIX, url, tokenFile, cwd: remoteCwd }]
if (!Array.isArray(records) || !records.length) throw new Error('At least one PAC endpoint is required')
const names = new Set()
const ids = new Set()
const labels = new Set()
const endpointResults = await Promise.all(records.map(async (entry) => {
  if (!entry || typeof entry.id !== 'string' || !entry.id || typeof entry.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(entry.name) ||
      typeof entry.url !== 'string' || typeof entry.tokenFile !== 'string' || typeof entry.cwd !== 'string' || !entry.cwd ||
      (entry.displayName !== undefined && (typeof entry.displayName !== 'string' || !entry.displayName.trim() || entry.displayName.length > 64 || /[\x00-\x1f\x7f]/.test(entry.displayName))) ||
      (entry.modelPrefix !== undefined && (typeof entry.modelPrefix !== 'string' || !entry.modelPrefix.trim() || entry.modelPrefix.length > 32 || /[\x00-\x1f\x7f]/.test(entry.modelPrefix))) ||
      names.has(entry.name.toLowerCase()) || ids.has(entry.id) || labels.has((entry.displayName || entry.name).trim().toLowerCase())) throw new Error('Invalid or duplicate PAC endpoint')
  names.add(entry.name.toLowerCase())
  ids.add(entry.id)
  labels.add((entry.displayName || entry.name).trim().toLowerCase())
  try {
    const token = (await readFile(entry.tokenFile, 'utf8')).trim()
    if (!token) throw new Error('Empty credential')
    return { endpoint: { ...entry, token } }
  } catch { return { warning: { name: entry.name, code: 'unavailable' } } }
}))
const endpoints = endpointResults.flatMap((result) => result.endpoint ? [result.endpoint] : [])
const endpointWarnings = endpointResults.flatMap((result) => result.warning ? [result.warning] : [])
const child = spawnContained(binary, process.argv.slice(2), { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
child.on('error', (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
const sessions = new Map()
const store = process.env.PAC_SESSION_DIR ? createSessionStore(process.env.PAC_SESSION_DIR) : null
let failedResume = false
let client
const native = createAcpPeer(Duplex.from({ readable: child.stdout, writable: child.stdin }), {
  onRequest: (method, params) => client.call(method, params),
  onNotification: (method, params) => { if (!sessions.get(params?.sessionId)?.selected) client.notify(method, params) },
})

function publishBackground(session, state) {
  if (!state.connected || session.selected !== state.endpoint.id || !state.translator) return
  const tasks = [...state.translator.backgroundTasks(), ...(state.background?.snapshot() || [])]
  client.notify('pac/background_tasks_changed', { rootSessionId: session.id, tasks })
  if (process.env.PAC_TRACE_PATH) appendFileSync(process.env.PAC_TRACE_PATH, JSON.stringify({ backgroundSnapshot: tasks.length,
    shellBackgroundCount: state.background?.snapshot().length || 0 }) + '\n')
}

function combined(response, session, current) {
  const result = structuredClone(response)
  if (session.discoveryWarnings.length) {
    result._meta = { ...(result._meta || {}), pacDiscoveryWarnings: session.discoveryWarnings }
  }
  const choices = [...session.remotes.values()].filter((entry) => entry.connected).flatMap((entry) => entry.remote.models.models.map((model) => ({ value: `PAC_${entry.endpoint.name}/${model.id}`, name: `PAC ${entry.endpoint.displayName || entry.endpoint.name} / ${entry.endpoint.modelPrefix ? entry.endpoint.modelPrefix + ' ' : ''}${model.name}` })))
  const option = result.configOptions?.find((entry) => entry.category === 'model' || entry.id === 'model')
  if (option) {
    option.options = [...(option.options || []), ...choices.filter((choice) => !(option.options || []).some((entry) => entry.value === choice.value))]
    if (current) option.currentValue = current
  }
  result.models ??= { availableModels: (option?.options || []).filter((entry) => typeof entry?.value === 'string')
    .map((entry) => ({ modelId: entry.value, ...(typeof entry.name === 'string' ? { name: entry.name } : {}) })), currentModelId: option?.currentValue }
  result.models.availableModels ??= []
  for (const entry of option?.options || []) {
    if (typeof entry?.value === 'string' && !result.models.availableModels.some((model) => model.modelId === entry.value)) {
      result.models.availableModels.push({ modelId: entry.value, ...(typeof entry.name === 'string' ? { name: entry.name } : {}) })
    }
  }
  for (const choice of choices) if (!result.models.availableModels.some((entry) => entry.modelId === choice.value)) result.models.availableModels.push({ modelId: choice.value, name: choice.name })
  if (current) result.models.currentModelId = current
  return result
}

client = createAcpPeer(Duplex.from({ readable: process.stdin, writable: process.stdout }), {
  onRequest: async (method, params = {}) => {
    if (method === 'initialize') return native.call(method, params)
    if (method === 'session/load' || method === 'session/new') {
      if (method === 'session/new' && failedResume) throw new Error('PAC resume failed; refusing to start an unrelated session')
      let binding
      if (method === 'session/load') {
        failedResume = true
        binding = await store?.read(params.sessionId)
        if (!binding) throw new Error('PAC session binding is unavailable; refusing to resume a different session')
        if (await realpath(params.cwd) !== await realpath(binding.workspace)) throw new Error('PAC session workspace has changed')
      }
      const result = (await native.call(method, params)) || {}
      const session = { id: result.sessionId || params.sessionId, cwd: params.cwd, native: result, selected: binding?.pacId || null,
        remotes: new Map(), discoveryWarnings: [...endpointWarnings], modelQueue: Promise.resolve(), modelError: null }
      sessions.set(session.id, session)
      const targets = binding ? endpoints.filter((endpoint) => endpoint.id === binding.pacId) : endpoints
      if (binding && targets.length !== 1) throw new Error('The original PAC is unavailable; refusing to switch controllers')
      await Promise.all(targets.map(async (endpoint) => {
        const state = { endpoint, connected: true, automaticCompactions: new Map() }
        let sourceReady = false
        const connectionStarted = Date.now()
        const traceConnection = (stage) => {
          if (process.env.PAC_TRACE_PATH) appendFileSync(process.env.PAC_TRACE_PATH, JSON.stringify({ connectionStage: stage, elapsedMs: Date.now() - connectionStarted }) + '\n')
        }
        try {
          traceConnection('starting')
          if (process.env.PAC_EXPERIMENTAL_HOOKS === '1') {
            if (!process.env.PAC_SOURCE_BASH) throw new Error('A source shell is required for project hooks')
            state.hooks = await createProjectHooks({ root: params.cwd, shell: process.env.PAC_SOURCE_BASH })
          }
          if (process.env.PAC_EXPERIMENTAL_SKILLS === '1') state.skills = await createSourceSkills({ root: params.cwd, home: homedir() })
          state.allowedSkillRoots = new Set()
          if (process.env.PAC_EXPERIMENTAL_INSTRUCTIONS === '1') state.instructions = await readSourceInstructions({ root: params.cwd,
            ...(process.env.PAC_TEST_INSTRUCTION_BOUNDARY === 'workspace' ? { stopAt: params.cwd } : {}) })
          sourceReady = true
          const stream = await connectSource(endpoint)
          traceConnection('transport_connected')
          stream.once('close', () => {
            state.connected = false
            for (const pending of state.pendingWrites?.values() || []) pending.abort()
            for (const pending of state.pendingTerminalCreates?.values() || []) pending.abort()
            for (const toolCallId of state.pendingQuestions?.values() || []) {
              try { client.notify('pac/permission/cancelled', { sessionId: session.id, toolCallId }) } catch {}
            }
            if (state.terminal) void state.terminal.close().catch(() => {})
          })
          if (binding) state.translator = createSubagentTranslator({ localSessionId: session.id, remoteSessionId: binding.remoteSessionId, pacId: endpoint.id })
          state.remote = await openPacSession(stream, { cwd: endpoint.cwd, meta: { pac: { workspaceCwd: params.cwd,
            skills: state.skills?.list || [], instructions: (state.instructions || []).filter((entry) => !entry.paths), scopedRules: Array.isArray(state.instructions) } },
            ...(binding ? { resumeSessionId: binding.remoteSessionId } : {}),
            clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true, subagents: {}, session: { compaction: {} } },
          onRequest: async (remoteMethod, remoteParams) => {
            if (session.selected !== endpoint.id) throw new Error('Request from inactive PAC session')
            if (remoteMethod === 'fs/read_text_file') {
              if (process.env.PAC_TRACE_PATH) appendFileSync(process.env.PAC_TRACE_PATH, JSON.stringify({ sourceReadPath: isAbsolute(remoteParams.path || '') ? 'absolute' : 'relative' }) + '\n')
              if (process.env.PAC_TRACE_PATH && /hook-(block|error)\.txt$/.test(remoteParams.path || '')) appendFileSync(process.env.PAC_TRACE_PATH, JSON.stringify({ blockedFixtureRead: true }) + '\n')
              try { return await state.workspace.readTextFile(remoteParams) } catch (error) {
                if (!isAbsolute(remoteParams.path || '')) throw error
                const actual = await realpath(remoteParams.path)
                for (const root of state.allowedSkillRoots) {
                  const local = relative(root, actual)
                  if (local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local)) {
                    if (await realpath(root) !== root) throw new Error('Skill resource directory has changed')
                    const skillWorkspace = await createWorkspace({ root, sessionId: state.remote.sessionId })
                    if (process.env.PAC_TRACE_PATH) appendFileSync(process.env.PAC_TRACE_PATH, JSON.stringify({ skillResourceRead: true }) + '\n')
                    return skillWorkspace.readTextFile({ ...remoteParams, path: actual })
                  }
                }
                throw error
              }
            }
            if (remoteMethod === 'pac/instructions/match') {
              if (remoteParams.sessionId !== state.remote?.sessionId || (typeof remoteParams.path !== 'string' && typeof remoteParams.command !== 'string')) throw new Error('Invalid scoped instruction request')
              const path = typeof remoteParams.path === 'string' ? remoteParams.path : simpleBashReadPath(remoteParams.command)
              if (!path) return { instructions: [] }
              if (typeof remoteParams.command === 'string' && process.env.PAC_TRACE_PATH) appendFileSync(process.env.PAC_TRACE_PATH, JSON.stringify({ scopedBashRead: true }) + '\n')
              let workspace, actual
              try { [workspace, actual] = await Promise.all([realpath(session.cwd), realpath(resolve(session.cwd, path))]) }
              catch (error) { if (error.code === 'ENOENT') return { instructions: [] }; throw error }
              const local = relative(workspace, actual)
              if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) return { instructions: [] }
              const matching = (state.instructions || []).filter((entry) => entry.paths && matchesProjectRule(workspace, actual, entry.paths))
              const nested = await readSourceInstructions({ root: workspace, stopAt: workspace, nestedTarget: actual, nestedOnly: true })
              const nestedMatches = nested.filter((entry) => !entry.paths || matchesProjectRule(entry.base || workspace, actual, entry.paths))
              return { instructions: [...nestedMatches, ...matching].map(({ path, content }) => ({ path, content })) }
            }
            if (remoteMethod === 'pac/fs/read_image') {
              const result = await state.workspace.readImageFile(remoteParams)
              if (process.env.PAC_TRACE_PATH) appendFileSync(process.env.PAC_TRACE_PATH, JSON.stringify({ imageRead: true }) + '\n')
              return result
            }
            if (remoteMethod === 'pac/hooks/dispatch') {
              if (!state.hooks || remoteParams.sessionId !== state.remote?.sessionId) throw new Error('Project hooks are unavailable for this session')
              let output
              try {
                const hooks = await createProjectHooks({ root: session.cwd, shell: process.env.PAC_SOURCE_BASH })
                output = await hooks.dispatch(remoteParams.input)
              } catch (error) {
                if (process.env.PAC_TRACE_PATH) appendFileSync(process.env.PAC_TRACE_PATH, JSON.stringify({ hookFailure: true }) + '\n')
                throw error
              }
              if (process.env.PAC_TRACE_PATH) appendFileSync(process.env.PAC_TRACE_PATH, JSON.stringify({ hookEvent: remoteParams.input?.hook_event_name,
                tool: remoteParams.input?.tool_name, denied: output.hookSpecificOutput?.permissionDecision === 'deny' }) + '\n')
              return output
            }
            if (remoteMethod === 'pac/skills/invoke') {
              if (!state.skills || remoteParams.sessionId !== state.remote?.sessionId) throw new Error('Source skills are unavailable for this session')
              const skills = await createSourceSkills({ root: session.cwd, home: homedir() })
              const result = await skills.invoke({ name: remoteParams.name, args: remoteParams.args })
              state.allowedSkillRoots.add(await realpath(skills.rootFor(remoteParams.name)))
              if (process.env.PAC_TRACE_PATH) appendFileSync(process.env.PAC_TRACE_PATH, JSON.stringify({ skillInvoked: remoteParams.name }) + '\n')
              return result
            }
            if (remoteMethod === 'pac/questions/ask') {
              if (remoteParams.sessionId !== state.remote?.sessionId || typeof remoteParams.ownerSessionId !== 'string' || !Array.isArray(remoteParams.questions) ||
                  typeof remoteParams.toolCallId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(remoteParams.toolCallId) ||
                  state.pendingQuestions.has(remoteParams.toolCallId)) throw new Error('Invalid PAC question request')
              const toolCallId = state.translator.toolCallId(remoteParams.ownerSessionId, remoteParams.toolCallId)
              state.pendingQuestions.set(remoteParams.toolCallId, toolCallId)
              try {
                const decision = await client.call('session/request_permission', { sessionId: session.id,
                  _meta: { pac: { question: true } },
                  toolCall: { toolCallId, title: 'AskUserQuestion', kind: 'other', rawInput: { questions: remoteParams.questions } },
                  options: [{ optionId: 'answer', name: 'Answer', kind: 'allow_once' }, { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' }] }, 0)
                if (decision?.outcome?.outcome !== 'selected' || decision.outcome.optionId !== 'answer' || !decision._meta?.pac?.answers) throw new Error('PAC question was cancelled')
                return { answers: decision._meta.pac.answers }
              } finally { state.pendingQuestions.delete(remoteParams.toolCallId) }
            }
            if (remoteMethod === 'pac/questions/cancel') {
              if (remoteParams.sessionId !== state.remote?.sessionId || typeof remoteParams.toolCallId !== 'string' ||
                  !/^[A-Za-z0-9_-]{1,200}$/.test(remoteParams.toolCallId)) throw new Error('Invalid PAC question cancellation')
              const toolCallId = state.pendingQuestions.get(remoteParams.toolCallId)
              if (toolCallId) client.notify('pac/permission/cancelled', { sessionId: session.id, toolCallId })
              return { cancelled: !!toolCallId }
            }
            if (remoteMethod === 'fs/write_text_file') throw new Error('Uncancellable workspace writes are not supported')
            if (remoteMethod === 'pac/fs/write') {
              if (remoteParams.sessionId !== state.remote?.sessionId || !/^[0-9a-f-]{36}$/.test(remoteParams.operationId || '') ||
                  state.pendingWrites.has(remoteParams.operationId)) throw new Error('Invalid workspace write request')
              const controller = new AbortController()
              const toolCallId = `pac-file-${remoteParams.operationId}`
              state.pendingWrites.set(remoteParams.operationId, controller)
              const cancel = () => { try { client.notify('pac/permission/cancelled', { sessionId: session.id, toolCallId }) } catch {} }
              controller.signal.addEventListener('abort', cancel, { once: true })
              try {
                return await authorizedWrite({ signal: controller.signal, connected: () => state.connected,
                  authorize: async () => {
                    const decision = await client.call('session/request_permission', { sessionId: session.id,
                      toolCall: { toolCallId, title: 'Write on source workspace', kind: 'edit', rawInput: { file_path: remoteParams.path, content: remoteParams.content } },
                      options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }, { optionId: 'deny', name: 'Reject', kind: 'reject_once' }] }, 0)
                    return decision?.outcome?.outcome === 'selected' && decision.outcome.optionId === 'allow'
                  }, write: () => state.workspace.writeTextFile(remoteParams) })
              } finally {
                controller.signal.removeEventListener('abort', cancel)
                state.pendingWrites.delete(remoteParams.operationId)
              }
            }
            if (remoteMethod === 'pac/fs/cancel_write') {
              if (remoteParams.sessionId !== state.remote?.sessionId || !/^[0-9a-f-]{36}$/.test(remoteParams.operationId || '')) throw new Error('Invalid workspace write cancellation')
              const pending = state.pendingWrites.get(remoteParams.operationId)
              pending?.abort()
              return { cancelled: !!pending }
            }
            if (remoteMethod === 'pac/search/glob' || remoteMethod === 'pac/search/grep') {
              const result = await (remoteMethod === 'pac/search/glob' ? state.search.glob(remoteParams) : state.search.grep(remoteParams))
              if (process.env.PAC_TRACE_PATH) appendFileSync(process.env.PAC_TRACE_PATH, JSON.stringify({ searchRequest: remoteMethod }) + '\n')
              return result
            }
            if (remoteMethod === 'terminal/create') {
              if (!process.env.PAC_SOURCE_BASH || remoteParams.command !== 'bash' || remoteParams.args?.length !== 2 || remoteParams.args[0] !== '-c') throw new Error('Unsupported source shell request')
              return state.terminal.create({ ...remoteParams, command: process.env.PAC_SOURCE_BASH })
            }
            if (remoteMethod === 'pac/terminal/create') {
              if (remoteParams.sessionId !== state.remote?.sessionId || !/^[0-9a-f-]{36}$/.test(remoteParams.operationId || '') ||
                  !process.env.PAC_SOURCE_BASH || remoteParams.command !== 'bash' || remoteParams.args?.length !== 2 || remoteParams.args[0] !== '-c' ||
                  state.pendingTerminalCreates.has(remoteParams.operationId)) throw new Error('Invalid source shell request')
              const controller = new AbortController()
              state.pendingTerminalCreates.set(remoteParams.operationId, controller)
              try { return await state.terminal.create({ ...remoteParams, command: process.env.PAC_SOURCE_BASH }, { signal: controller.signal }) }
              finally { state.pendingTerminalCreates.delete(remoteParams.operationId) }
            }
            if (remoteMethod === 'pac/terminal/cancel_create') {
              if (remoteParams.sessionId !== state.remote?.sessionId || !/^[0-9a-f-]{36}$/.test(remoteParams.operationId || '')) throw new Error('Invalid source shell cancellation')
              const pending = state.pendingTerminalCreates.get(remoteParams.operationId)
              pending?.abort()
              return { cancelled: !!pending }
            }
            if (remoteMethod === 'pac/terminal/start_background') {
              if (remoteParams.sessionId !== state.remote?.sessionId || !/^[0-9a-f-]{36}$/.test(remoteParams.operationId || '') ||
                  state.pendingTerminalCreates.has(remoteParams.operationId) || !process.env.PAC_SOURCE_BASH || remoteParams.command !== 'bash' ||
                  remoteParams.args?.length !== 2 || remoteParams.args[0] !== '-c') throw new Error('Unsupported source shell request')
              const controller = new AbortController()
              state.pendingTerminalCreates.set(remoteParams.operationId, controller)
              try { return await state.background.start({ ...remoteParams, command: process.env.PAC_SOURCE_BASH }, { signal: controller.signal }) }
              finally { state.pendingTerminalCreates.delete(remoteParams.operationId) }
            }
            if (remoteMethod === 'pac/terminal/task_output') return state.background.output(remoteParams)
            if (remoteMethod === 'pac/terminal/task_stop') {
              try {
                const result = await state.background.stop(remoteParams)
                if (process.env.PAC_TRACE_PATH) appendFileSync(process.env.PAC_TRACE_PATH, JSON.stringify({ shellStop: result.status }) + '\n')
                return result
              } catch (error) {
                if (process.env.PAC_TRACE_PATH) appendFileSync(process.env.PAC_TRACE_PATH, JSON.stringify({ shellStopError: error.message }) + '\n')
                throw error
              }
            }
            if (remoteMethod === 'terminal/output') return state.terminal.output(remoteParams)
            if (remoteMethod === 'terminal/wait_for_exit') return state.terminal.waitForExit(remoteParams)
            if (remoteMethod === 'terminal/kill') return state.terminal.kill(remoteParams)
            if (remoteMethod === 'terminal/release') return state.terminal.release(remoteParams)
            return client.call(remoteMethod, { ...remoteParams, sessionId: session.id })
          },
          onNotification: (remoteMethod, remoteParams) => {
            const update = remoteParams?.update
            if (session.selected === endpoint.id && state.compaction && remoteMethod === 'session/update' && remoteParams?.sessionId === state.remote?.sessionId) {
              if (update?.sessionUpdate === 'compaction_summary_chunk' && update.content?.type === 'text') state.compaction.chunks += update.content.text
              if (update?.sessionUpdate === 'compaction_update') {
                if (update.status === 'completed' || update.status === 'failed' || update.status === 'cancelled') {
                  state.compaction.status = update.status
                  const text = Array.isArray(update.summary) ? update.summary.filter((block) => block?.type === 'text').map((block) => block.text).join('') : ''
                  if (text) state.compaction.summary = text
                  state.compaction.settle()
                }
              }
              if (['compaction_update', 'compaction_summary_chunk'].includes(update?.sessionUpdate)) return
            }
            if (process.env.PAC_TRACE_PATH && remoteMethod === 'session/update') appendFileSync(process.env.PAC_TRACE_PATH, JSON.stringify({
              type: update?.sessionUpdate, compactionStatus: update?.sessionUpdate === 'compaction_update' ? update.status : undefined,
              title: update?.title, background: update?.rawInput?.run_in_background ?? update?._meta?.pacProbe?.background,
              scopedInstructionOwner: ['main', 'subagent'].includes(update?._meta?.pacProbe?.scopedInstructionOwner) ? update._meta.pacProbe.scopedInstructionOwner : undefined,
              observedModel: typeof update?._meta?.['_claude/model'] === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(update._meta['_claude/model']) ? update._meta['_claude/model'] : undefined,
              meta: update?._meta ? Object.keys(update._meta) : [],
            }) + '\n')
            if (session.selected === endpoint.id && !state.compaction && remoteMethod === 'session/update' && remoteParams?.sessionId === state.remote?.sessionId &&
                ['compaction_update', 'compaction_summary_chunk'].includes(update?.sessionUpdate)) {
              if (update.sessionUpdate === 'compaction_update' && typeof update.compactionId === 'string' && update.compactionId.length <= 256 &&
                  ['in_progress', 'completed', 'failed', 'cancelled'].includes(update.status) &&
                  !['completed', 'failed', 'cancelled'].includes(state.automaticCompactions.get(update.compactionId)) && state.automaticCompactions.get(update.compactionId) !== update.status) {
                state.automaticCompactions.set(update.compactionId, update.status)
                if (state.automaticCompactions.size > 100) state.automaticCompactions.delete(state.automaticCompactions.keys().next().value)
                const label = { in_progress: 'started', completed: 'completed', failed: 'failed', cancelled: 'was cancelled' }[update.status]
                client.notify('session/update', { sessionId: session.id, update: { sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: `\n\nPAC Bridge: automatic context compaction ${label}.\n\n` } } })
              }
              return
            }
            if (session.selected === endpoint.id) {
              const event = remoteMethod === 'session/update' ? state.translator.translate(remoteParams)
                : { method: remoteMethod, params: { ...remoteParams, sessionId: session.id } }
              if (state.completionCapture && event.method === 'session/update' && event.params.sessionId === session.id &&
                  event.params.update?.sessionUpdate === 'agent_message_chunk' && event.params.update.content?.type === 'text') {
                state.completionCapture.text = (state.completionCapture.text + event.params.update.content.text).slice(-1800)
              }
              if (['session/update', 'opencode/session/child_update'].includes(event.method) && event.params.update?.title === 'mcp__pac__AskUserQuestion') {
                event.params.update = { ...event.params.update, title: 'AskUserQuestion' }
              }
              if (process.env.PAC_TRACE_PATH && event.method === 'opencode/session/child_update') appendFileSync(process.env.PAC_TRACE_PATH, JSON.stringify({
                translated: event.method, status: event.params.status, childUpdate: event.params.update?.sessionUpdate,
              }) + '\n')
              client.notify(event.method, event.params)
              if (['subagent_spawned', 'subagent_state_update'].includes(update?.sessionUpdate)) {
                publishBackground(session, state)
              }
            }
          },
          })
          traceConnection('session_ready')
          state.workspace = await createWorkspace({ root: params.cwd, sessionId: state.remote.sessionId })
          state.pendingTerminalCreates = new Map()
          state.pendingQuestions = new Map()
          state.pendingWrites = new Map()
          state.search = await createSearch({ root: params.cwd, sessionId: state.remote.sessionId, executable: process.env.PAC_SOURCE_RG || 'rg' })
          state.terminal = await createTerminalManager({ root: params.cwd, sessionId: state.remote.sessionId, authorize: async (command, { signal } = {}) => {
            const toolCallId = `pac-terminal-${randomUUID()}`
            const cancel = () => { try { client.notify('pac/permission/cancelled', { sessionId: session.id, toolCallId }) } catch {} }
            signal?.addEventListener('abort', cancel, { once: true })
            try {
              if (signal?.aborted) return false
              const result = await client.call('session/request_permission', { sessionId: session.id,
                toolCall: { toolCallId, title: 'Bash on source workspace', kind: 'execute', rawInput: command },
                options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }, { optionId: 'deny', name: 'Reject', kind: 'reject_once' }] }, 0)
              return result?.outcome?.outcome === 'selected' && result.outcome.optionId === 'allow'
            } finally { signal?.removeEventListener('abort', cancel) }
          } })
          state.translator ??= createSubagentTranslator({ localSessionId: session.id, remoteSessionId: state.remote.sessionId, pacId: endpoint.id })
          state.background = createBackgroundTerminal({ terminal: state.terminal, sessionId: state.remote.sessionId,
            onChange: () => publishBackground(session, state) })
          if (!state.connected) throw new Error('PAC disconnected during setup')
          session.remotes.set(endpoint.id, state)
        } catch (error) {
          traceConnection('failed')
          state.remote?.close()
          const reason = error instanceof Error ? error.message : 'Unknown error'
          const code = sourceReady ? 'unavailable'
            : ['Unsupported project rule paths', 'Rule aliases are not supported', 'Rule glob expansion exceeds the supported limit'].includes(reason) ? 'rule_frontmatter_unsupported'
              : reason === 'External instruction imports require approval and are not supported' ? 'external_import_unsupported'
                : 'source_setup_failed'
          session.discoveryWarnings.push({ name: endpoint.name, code })
          const errno = typeof error?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code) ? ` (${error.code})` : ''
          process.stderr.write(`PAC ${endpoint.name} unavailable: ${code}${errno}\n`)
        }
      }))
      if (binding) {
        const restored = session.remotes.get(binding.pacId)
        if (!restored?.connected) throw new Error('The original PAC session could not be restored')
        if (restored.remote.models.current !== binding.model) await restored.remote.selectModel(binding.model)
        failedResume = false
      }
      return combined(result, session, binding ? `PAC_${targets[0].name}/${binding.model}` : undefined)
    }
    const session = sessions.get(params.sessionId)
    if (!session) return native.call(method, params)
    if (method === 'session/set_mode') session.mode = params.modeId
    const selection = method === 'session/set_model' ? params.modelId : method === 'session/set_config_option' && params.configId === 'model' ? params.value : undefined
    const endpoint = typeof selection === 'string' ? endpoints.find((entry) => selection.startsWith(`PAC_${entry.name}/`)) : undefined
    if (typeof selection === 'string' && selection.startsWith('PAC_')) {
      const selected = session.modelQueue.then(async () => {
        const state = endpoint && session.remotes.get(endpoint.id)
        if (!state?.connected) throw new Error('PAC is unavailable')
        if (session.selected && session.selected !== endpoint.id) throw new Error('Start a new session to select another PAC')
        await state.remote.selectModel(selection.slice(`PAC_${endpoint.name}/`.length))
        if (session.mode) await state.remote.call('session/set_mode', { modeId: ({ build: 'default', yolo: 'bypassPermissions', plan: 'plan' })[session.mode] || session.mode })
        session.selected = endpoint.id
        if (store) {
          try {
            await store.write({ version: 1, sessionId: session.id, pacId: endpoint.id, remoteSessionId: state.remote.sessionId,
              model: selection.slice(`PAC_${endpoint.name}/`.length), workspace: await realpath(session.cwd) })
          } catch (error) {
            state.remote.close()
            throw new Error(`Could not persist PAC session binding: ${error.message}`)
          }
        }
        session.modelError = null
        return method === 'session/set_model' ? {} : combined(session.native, session, selection)
      })
      session.modelQueue = selected.then(() => {}, (error) => { session.modelError = error })
      return selected
    }
    await session.modelQueue
    if (session.modelError) throw new Error(`PAC model selection failed: ${session.modelError.message}`)
    if (selection && session.selected) throw new Error('Start a new session to switch away from a PAC')
    if (!session.selected) return native.call(method, params, method === 'session/prompt' ? 0 : undefined)
    if (method === 'session/set_mode') params = { ...params, modeId: ({ build: 'default', yolo: 'bypassPermissions', plan: 'plan' })[params.modeId] || params.modeId }
    const selected = session.remotes.get(session.selected)
    if (!selected?.connected) throw new Error('PAC disconnected; the last operation outcome may be unknown')
    if (method === 'pac/tasks/stop') {
      if (typeof params.taskId !== 'string' || !params.taskId) throw new Error('Invalid PAC task identity')
      try {
        const result = params.taskId.startsWith('pac-shell-')
          ? await selected.background.stop({ sessionId: selected.remote.sessionId, taskId: params.taskId })
          : await selected.remote.call('pac/tasks/stop_native', { taskId: selected.translator.remoteChildId(params.taskId) })
        if (process.env.PAC_TRACE_PATH) appendFileSync(process.env.PAC_TRACE_PATH, JSON.stringify({ taskStopStatus: result.status }) + '\n')
        return result
      } catch (error) {
        const category = ['Unknown or inactive', 'Unknown native', 'unavailable', 'not found', 'not supported', 'timed out'].find((value) => error.message.includes(value)) || 'other'
        if (process.env.PAC_TRACE_PATH) appendFileSync(process.env.PAC_TRACE_PATH, JSON.stringify({ taskStopError: category }) + '\n')
        throw error
      }
    }
    if (method === 'session/prompt' || method === 'pac/compact') {
      try { await assertNoUnsupportedOpenCodePlugins({ root: session.cwd, home: homedir() }) } catch (error) {
        const supportedMessage = /^OpenCode (?:permission|instructions|mcp|skills|agent permission) configuration is not yet supported by PAC Bridge$/.test(error.message)
        const message = error.message === 'Configured OpenCode plugins and hooks are not yet supported by PAC Bridge'
          ? 'PAC Bridge stopped this turn because configured OpenCode plugins and hooks are not yet supported.'
          : supportedMessage ? `PAC Bridge stopped this turn: ${error.message}.`
            : 'PAC Bridge could not verify the OpenCode configuration; the turn was stopped.'
        client.notify('session/update', { sessionId: session.id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: message } } })
        throw error
      }
    }
    if (method === 'pac/compact') {
      if (selected.compaction) throw new Error('PAC compaction is already in progress')
      let settle
      const terminal = new Promise((resolve) => { settle = resolve })
      const operation = { chunks: '', summary: '', status: null, settle }
      selected.compaction = operation
      try {
        await selected.remote.call('session/prompt', { prompt: [{ type: 'text', text: '/compact' }] }, 0)
        await selected.remote.drainNotifications()
        if (!operation.status) await Promise.race([terminal, new Promise((resolve) => setTimeout(resolve, 3000))])
        if (operation.status !== 'completed') throw new Error('PAC compaction did not report a confirmed successful result')
        return { status: 'completed', summary: operation.summary || operation.chunks || '' }
      } finally { if (selected.compaction === operation) selected.compaction = null }
    }
    if (method === 'session/prompt' && Array.isArray(params.prompt)) {
      // The remote Claude runtime also describes its own process directory in
      // the environment. Restate the source directory alongside each user
      // turn so that controller paths are not mistaken for project paths.
      params = { ...params, prompt: [{ type: 'text', text: `<system-reminder>PAC Bridge source workspace: ${JSON.stringify(session.cwd)}. This is the user's working directory; the remote controller's process directory is internal. Execute project commands and resolve project paths in the source workspace.</system-reminder>` }, ...params.prompt] }
    }
    const completionCapture = method === 'session/prompt' && process.env.PAC_TURN_NOTIFY_SCRIPT
      ? { id: randomUUID(), text: '' } : null
    if (completionCapture) selected.completionCapture = completionCapture
    try {
      const result = await selected.remote.call(method, params, method === 'session/prompt' ? 0 : undefined)
      if (method === 'session/prompt') await selected.remote.drainNotifications()
      if (completionCapture && result?.stopReason === 'end_turn') notifyTurnComplete({ script: process.env.PAC_TURN_NOTIFY_SCRIPT,
        sessionId: session.id, turnId: completionCapture.id, cwd: session.cwd, message: completionCapture.text })
      return result
    } catch (error) {
      if (method === 'session/prompt' && error.message === 'Authentication required') {
        client.notify('session/update', { sessionId: session.id, update: { sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '\n\nPAC Bridge: Claude authentication is required on the selected PAC controller. Sign in there and retry your request.' } } })
      }
      throw error
    } finally {
      if (completionCapture && selected.completionCapture === completionCapture) selected.completionCapture = null
    }
  },
  onNotification: (method, params = {}) => {
    const session = sessions.get(params.sessionId)
    if (session?.selected && session.remotes.get(session.selected)?.connected) session.remotes.get(session.selected).remote.notify(method, params)
    else if (session?.selected) throw new Error('PAC disconnected; the last operation outcome may be unknown')
    else native.notify(method, params)
  },
})
let stopping = false
async function shutdown() {
  if (stopping) return
  stopping = true
  for (const session of sessions.values()) for (const state of session.remotes.values()) { await state.terminal.close(); state.remote.close() }
  native.close()
  stopContained(child)
}
process.on('SIGTERM', () => { void shutdown() })
process.on('SIGINT', () => { void shutdown() })
process.stdin.on('end', () => { void shutdown() })
