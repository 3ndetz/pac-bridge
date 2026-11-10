import { Duplex } from 'node:stream'
import { writeFile } from 'node:fs/promises'
import { createAcpPeer } from '../../src/acp-peer.mjs'

const native = process.argv.includes('--native')
let selected = 'initial'
let firstPrompt
const models = [{ value: 'initial', name: 'Initial' }, { value: 'sonnet', name: 'Sonnet' }, { value: 'opus', name: 'Opus' }]
const peer = createAcpPeer(Duplex.from({ readable: process.stdin, writable: process.stdout }), {
  onRequest: async (method, params) => {
    if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: { loadSession: true } }
    if (method === 'session/new') return { sessionId: native ? 'native-session' : 'remote-session',
      ...(process.argv.includes('--empty-model-block') ? { models: { availableModels: [] } } : {}), configOptions: [
      { id: 'model', category: 'model', currentValue: selected, options: models }
    ] }
    if (method === 'session/load') {
      if (params.sessionId !== (native ? 'native-session' : 'remote-session')) throw new Error('Unknown fake session')
      return { sessionId: params.sessionId, configOptions: [{ id: 'model', category: 'model', currentValue: selected, options: models }] }
    }
    if (method === 'session/set_config_option') {
      await new Promise((resolve) => setTimeout(resolve, params.value === 'sonnet' ? 100 : 1))
      selected = params.value
      return { configOptions: [{ id: 'model', category: 'model', currentValue: selected, options: models }] }
    }
    if (method === 'session/prompt') {
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
        const imageCount = params.prompt?.filter((part) => part.type === 'image' && part.mimeType === 'image/png').length || 0
        peer.notify('session/update', { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `remembered:${firstPrompt} model:${selected} images:${imageCount}` } } })
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
