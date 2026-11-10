import { timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { createOpencodeTurnChannel } from './opencode-turn-channel.mjs'

// Experimental text-only transport. Unsupported events and permissions must
// terminate the turn, never be translated into a successful text answer.
export function createOpencodeProvider({ router, token, cwd, maxBodyBytes = 1024 * 1024, permissionTimeoutMs = 600000, onFailure = () => {} }) {
  if (!router || typeof router.prompt !== 'function' || typeof token !== 'string' || token.length < 32 || typeof cwd !== 'string' || !cwd || !Number.isSafeInteger(permissionTimeoutMs) || permissionTimeoutMs < 1) throw new Error('Invalid provider configuration')
  const expected = Buffer.from(`Bearer ${token}`)
  const seen = new Map()
  const turns = new Map()
  function cancelTurn(sessionId, turn) {
    clearTimeout(turn.timer)
    turn.cancellation.abort()
    turn.channel.close()
    if (turns.get(sessionId) === turn) turns.delete(sessionId)
  }
  const server = createServer(async (request, response) => {
    const fail = (status, message) => { if (!response.headersSent) response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message } })); else response.destroy() }
    const auth = Buffer.from(request.headers.authorization || '')
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return fail(401, 'Unauthorized')
    if (request.method !== 'POST' || !['/v1/chat/completions', '/pac/approval'].includes(request.url)) return fail(404, 'Not found')
    const sessionId = request.headers['x-pac-session-id']
    const messageId = request.headers['x-pac-message-id']
    if (request.url !== '/pac/approval' && (typeof sessionId !== 'string' || typeof messageId !== 'string' || !sessionId || !messageId || sessionId.length > 512 || messageId.length > 512 || /[\x00-\x1f]/.test(sessionId + messageId))) return fail(400, 'Missing OpenCode session or message identity')
    try {
      let size = 0
      const chunks = []
      for await (const chunk of request) {
        size += chunk.length
        if (size > maxBodyBytes) return fail(413, 'Request too large')
        chunks.push(chunk)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (request.url === '/pac/approval') {
        const turn = turns.get(body.sessionId)
        const permission = turn?.pending
        if (!permission || permission.id !== body.id || permission.resolved || !['inspect', 'resolve'].includes(body.action)) return fail(400, 'Unknown permission')
        if (body.action === 'inspect') {
          const toolCall = permission.toolCall || {}
          const title = typeof toolCall.title === 'string' ? toolCall.title.slice(0, 512) : 'PAC action'
          return response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ title, toolCall }))
        }
        if (!['allow', 'deny'].includes(body.decision)) return fail(400, 'Invalid decision')
        const kind = body.decision === 'allow' ? 'allow_once' : 'reject_once'
        const option = permission.options.find((entry) => entry.kind === kind)
        if (!option) return fail(400, 'Decision is unsupported')
        turn.channel.resolvePermission(permission.id, body.sessionId, option.optionId)
        permission.resolved = true
        return response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
      }
      const last = Array.isArray(body.messages) ? body.messages.at(-1) : undefined
      if (body.stream !== true || typeof body.model !== 'string' || !body.model.startsWith('PAC_') || !last || !['user', 'tool'].includes(last.role)) return fail(400, 'Unsupported provider request')
      // OpenCode also sends auxiliary requests with the same message id and
      // no tools (for example title generation). Never send those to Claude.
      // A real turn with tools disabled is intentionally unsupported for now.
      if (!Array.isArray(body.tools) || !body.tools.length) return fail(400, 'PAC requests without tools are unsupported')
      let messages = seen.get(sessionId)
      if (!messages) {
        if (seen.size >= 1024) return fail(503, 'Session capacity reached')
        messages = new Set()
        seen.set(sessionId, messages)
      }
      let turn = turns.get(sessionId)
      if (last.role === 'user') {
        if (typeof last.content !== 'string' || !last.content) return fail(400, 'Unsupported user message')
        const hasPriorConversation = body.messages.some((entry) => entry.role === 'assistant' || entry.role === 'tool') || body.messages.filter((entry) => entry.role === 'user').length > 1
        if (hasPriorConversation && !router.hasSession?.(sessionId)) return fail(400, 'PAC session binding is unavailable; refusing to start a different conversation')
        if (messages.has(messageId)) return fail(400, 'Duplicate turn; outcome may be unknown')
        if (turn) return fail(400, 'A PAC turn is already active')
        if (messages.size >= 4096) return fail(503, 'Session turn capacity reached')
        messages.add(messageId)
        const cancellation = new AbortController()
        const channel = createOpencodeTurnChannel({ sessionId })
        turn = { messageId, model: body.model, cancellation, channel, pending: null, streaming: false }
        turns.set(sessionId, turn)
        channel.start((update) => router.prompt({ sessionId, model: body.model, cwd }, [{ type: 'text', text: last.content }], update, { signal: cancellation.signal }))
      } else {
        if (!turn || turn.messageId !== messageId || turn.model !== body.model || !turn.pending?.resolved || last.tool_call_id !== turn.pending.id) return fail(400, 'Invalid PAC continuation')
        clearTimeout(turn.timer)
        turn.pending = null
      }
      if (turn.streaming) return fail(400, 'A PAC response segment is already active')
      turn.streaming = true
      let completed = false
      response.on('close', () => { if (!completed) cancelTurn(sessionId, turn) })
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const write = (delta, finish = null) => response.write(`data: ${JSON.stringify({ id: messageId, object: 'chat.completion.chunk', created: 0,
        model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
      write({ role: 'assistant' })
      while (true) {
        const event = await turn.channel.next()
        if (event.type === 'permission') {
          if (!body.tools.some((tool) => tool.function?.name === 'pac_approval') ||
              !event.options.some((option) => option.kind === 'allow_once') || !event.options.some((option) => option.kind === 'reject_once')) throw new Error('PAC permission cannot be represented')
          turn.pending = { ...event, resolved: false }
          turn.timer = setTimeout(() => cancelTurn(sessionId, turn), permissionTimeoutMs)
          turn.timer.unref()
          write({ tool_calls: [{ index: 0, id: event.id, type: 'function', function: { name: 'pac_approval', arguments: JSON.stringify({ id: event.id }) } }] })
          write({}, 'tool_calls')
          turn.streaming = false
          completed = true
          response.end('data: [DONE]\n\n')
          return
        }
        if (event.type === 'error') throw event.error
        if (event.type === 'done') {
          if (event.result?.stopReason !== 'end_turn') throw new Error('PAC turn did not finish normally')
          write({}, 'stop')
          turn.streaming = false
          turns.delete(sessionId)
          completed = true
          turn.channel.close()
          response.end('data: [DONE]\n\n')
          return
        }
        const { method, params } = event.event
        const update = params?.update
        if (method === 'session/update' && update?.sessionUpdate === 'available_commands_update') {
          write({ content: '[PAC: remote slash commands are not yet available in OpenCode.]\n' })
          continue
        }
        if (method === '_auth/status_update') {
          write({ content: '[PAC: remote authentication status changed.]\n' })
          continue
        }
        if (method === 'session/update' && update?.sessionUpdate === 'usage_update') {
          write({ content: '[PAC: remote usage metrics are not yet displayed.]\n' })
          continue
        }
        if (method === 'session/update' && update?.sessionUpdate === 'session_info_update') {
          write({ content: '[PAC: remote session information changed.]\n' })
          continue
        }
        if (method === 'session/update' && ['tool_call', 'tool_call_update'].includes(update?.sessionUpdate)) {
          const visible = Object.fromEntries(['sessionUpdate', 'toolCallId', 'title', 'kind', 'status', 'rawInput', 'rawOutput', 'content', 'locations']
            .filter((key) => Object.hasOwn(update, key)).map((key) => [key, update[key]]))
          const description = JSON.stringify(visible)
          if (Buffer.byteLength(description) > 1024 * 1024) throw new Error('PAC tool update exceeds size limit')
          write({ content: `\n[PAC tool event]\n${description}\n` })
          continue
        }
        if (method !== 'session/update' || update?.sessionUpdate !== 'agent_message_chunk' || update.content?.type !== 'text') throw new Error('Unsupported PAC event; turn cannot be represented')
        write({ content: update.content.text })
      }
    } catch (error) {
      const category = ['Selected PAC model is unavailable', 'PAC model selection was not confirmed', 'Unsupported ACP version',
        'ACP session identity is missing', 'ACP connection lost', 'ACP request timed out', 'Unsupported PAC event',
        'PAC turn did not finish normally'].find((value) => error?.message?.includes(value)) || 'other'
      const phase = ['initialize', 'session-new', 'select-model', 'prompt'].includes(error?.pacPhase) ? error.pacPhase : 'unknown'
      try { onFailure(`${category} (${phase})`) } catch {}
      fail(502, 'PAC turn failed or its outcome is unknown')
    }
  })
  server.requestPermission = (sessionId, params) => {
    const turn = turns.get(sessionId)
    if (!turn) throw new Error('No active PAC turn for permission')
    return turn.channel.requestPermission(params, turn.cancellation.signal)
  }
  server.on('close', () => { for (const [sessionId, turn] of turns) cancelTurn(sessionId, turn) })
  return server
}
