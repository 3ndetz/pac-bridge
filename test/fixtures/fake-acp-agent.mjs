import { Duplex } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { access, appendFile, readFile, writeFile } from 'node:fs/promises'
import { createAcpPeer } from '../../src/acp-peer.mjs'

const native = process.argv.includes('--native')
let selected = 'initial'
let firstPrompt
let cancelTurn
let workspace
const models = [{ value: 'initial', name: 'Initial' }, { value: 'sonnet', name: 'Sonnet' }, { value: 'opus', name: 'Opus' }]
const peer = createAcpPeer(Duplex.from({ readable: process.stdin, writable: process.stdout }), {
  onNotification: async (method) => {
    if (method === 'session/cancel' && cancelTurn) {
      if (process.env.PAC_TEST_TURN_CANCEL_FILE) await writeFile(process.env.PAC_TEST_TURN_CANCEL_FILE, 'cancelled')
      cancelTurn()
    }
  },
  onRequest: async (method, params) => {
    if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: { loadSession: true } }
    if (method === 'session/new') {
      workspace = params?._meta?.pac?.workspaceCwd
      return { sessionId: native ? 'native-session' : 'remote-session',
      ...(process.argv.includes('--empty-model-block') ? { models: { availableModels: [] } } : {}), configOptions: [
      { id: 'model', category: 'model', currentValue: selected, options: models }
    ] } }
    if (method === 'session/load') {
      if (params.sessionId !== (native ? 'native-session' : 'remote-session')) throw new Error('Unknown fake session')
      if (process.env.PAC_TEST_CONVERSATION_FILE) firstPrompt = await readFile(process.env.PAC_TEST_CONVERSATION_FILE, 'utf8')
      return { sessionId: params.sessionId, configOptions: [{ id: 'model', category: 'model', currentValue: selected, options: models }] }
    }
    if (method === 'session/set_config_option') {
      await new Promise((resolve) => setTimeout(resolve, params.value === 'sonnet' ? 100 : 1))
      selected = params.value
      return { configOptions: [{ id: 'model', category: 'model', currentValue: selected, options: models }] }
    }
    if (method === 'session/prompt') {
      if (process.argv.includes('--workspace-operations')) {
        if (!workspace) throw new Error('Source workspace was not provided')
        const path = join(workspace, 'remote-fixture.txt')
        if (process.env.PAC_REQUIRE_DISTINCT_FS === '1') {
          let exists = false
          try { await access(path); exists = true } catch (error) { if (error.code !== 'ENOENT') throw error }
          if (exists) throw new Error('Source fixture is visible on the controller')
        }
        const before = await peer.call('fs/read_text_file', { sessionId: params.sessionId, path })
        if (before.content !== 'SOURCE_ONLY_MARKER') throw new Error('Wrong workspace content')
        const search = await peer.call('pac/search/grep', { sessionId: params.sessionId, path: workspace, pattern: 'SOURCE_ONLY_MARKER', outputMode: 'content' })
        if (!search.output?.includes('SOURCE_ONLY_MARKER')) throw new Error('Source search did not find the fixture')
        await peer.call('pac/fs/write', { sessionId: params.sessionId, operationId: randomUUID(), path, content: 'SOURCE_WRITTEN_MARKER' }, 0)
        const terminal = await peer.call('pac/terminal/create', { sessionId: params.sessionId, operationId: randomUUID(), command: 'bash', args: ['-c', 'printf SHELL_SOURCE_OK'], cwd: workspace }, 0)
        const status = await peer.call('terminal/wait_for_exit', { sessionId: params.sessionId, terminalId: terminal.terminalId }, 0)
        const output = await peer.call('terminal/output', { sessionId: params.sessionId, terminalId: terminal.terminalId })
        await peer.call('terminal/release', { sessionId: params.sessionId, terminalId: terminal.terminalId })
        if (status.exitCode !== 0 || output.output !== 'SHELL_SOURCE_OK') throw new Error('Source shell output was incorrect')
        const failing = await peer.call('pac/terminal/create', { sessionId: params.sessionId, operationId: randomUUID(), command: 'bash', args: ['-c', 'printf SHELL_SOURCE_FAILURE; exit 7'], cwd: workspace }, 0)
        const failed = await peer.call('terminal/wait_for_exit', { sessionId: params.sessionId, terminalId: failing.terminalId }, 0)
        const failedOutput = await peer.call('terminal/output', { sessionId: params.sessionId, terminalId: failing.terminalId })
        await peer.call('terminal/release', { sessionId: params.sessionId, terminalId: failing.terminalId })
        if (failed.exitCode !== 7 || failedOutput.output !== 'SHELL_SOURCE_FAILURE') throw new Error('Source shell failure was not preserved')
        peer.notify('session/update', { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'source workspace read and write completed; search and shell completed' } } })
        return { stopReason: 'end_turn' }
      }
      if (process.argv.includes('--slow-response')) {
        const cancelled = new Promise((resolve) => { cancelTurn = resolve })
        if (process.env.PAC_TEST_TURN_COUNT_FILE) await appendFile(process.env.PAC_TEST_TURN_COUNT_FILE, 'started\n')
        if (process.env.PAC_TEST_TURN_STARTED_FILE) await writeFile(process.env.PAC_TEST_TURN_STARTED_FILE, 'started')
        await cancelled
        cancelTurn = null
        return { stopReason: 'cancelled' }
      }
      if (process.argv.includes('--question-response')) {
        let result
        try { result = await peer.call('pac/questions/ask', { sessionId: params.sessionId, ownerSessionId: params.sessionId, toolCallId: 'fake-question', questions: [
          { question: 'Name?', header: 'Name', options: [{ label: 'A', description: 'Option A' }], multiSelect: false },
          { question: 'Colors?', header: 'Colors', options: [{ label: 'Red', description: 'Red' }, { label: 'Blue', description: 'Blue' }], multiSelect: true },
        ] }, 0) } catch {
          if (process.env.PAC_TEST_QUESTION_CANCEL_FILE) await writeFile(process.env.PAC_TEST_QUESTION_CANCEL_FILE, 'cancelled')
          peer.notify('session/update', { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fake PAC question cancelled' } } })
          return { stopReason: 'end_turn' }
        }
        peer.notify('session/update', { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `fake PAC answers ${JSON.stringify(result.answers)}` } } })
        return { stopReason: 'end_turn' }
      }
      if (process.argv.includes('--conversation')) {
        firstPrompt ??= params.prompt?.find((part) => part.type === 'text')?.text || ''
        if (process.env.PAC_TEST_CONVERSATION_FILE) await writeFile(process.env.PAC_TEST_CONVERSATION_FILE, firstPrompt)
        if (process.env.PAC_TEST_THOUGHT === '1') peer.notify('session/update', { sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'SYNTHETIC_THOUGHT_MARKER' } } })
        const imageCount = params.prompt?.filter((part) => part.type === 'image' && part.mimeType === 'image/png').length || 0
        peer.notify('session/update', { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `remembered:${firstPrompt} model:${selected} images:${imageCount} identity:${process.env.PAC_TEST_IDENTITY || 'default'}` } } })
        setTimeout(() => { try { peer.notify('session/update', { sessionId: params.sessionId, update: { sessionUpdate: 'session_info_update' } }) } catch {} }, 30)
        return { stopReason: 'end_turn' }
      }
      if (process.argv.includes('--permission-response')) {
        const answer = await peer.call('session/request_permission', { sessionId: params.sessionId,
          toolCall: { toolCallId: 'fake-write', title: 'Write test file', kind: 'edit', rawInput: { path: 'fixture.txt' } },
          options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] }, 0)
        peer.notify('session/update', { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `fake PAC permission ${answer.outcome.optionId}` } } })
        return { stopReason: 'end_turn' }
      }
      if (process.argv.includes('--text-response')) {
        peer.notify('session/update', { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `fake PAC ${selected} response` } } })
        return { stopReason: 'end_turn' }
      }
      return { selected }
    }
    throw new Error('Unsupported fake request')
  },
})
process.stdin.on('end', () => peer.close())
