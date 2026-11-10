import { timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'

// Experimental text-only transport. Unsupported events and permissions must
// terminate the turn, never be translated into a successful text answer.
export function createOpencodeProvider({ router, token, cwd, maxBodyBytes = 1024 * 1024, onFailure = () => {} }) {
  if (!router || typeof router.prompt !== 'function' || typeof token !== 'string' || token.length < 32 || typeof cwd !== 'string' || !cwd) throw new Error('Invalid provider configuration')
  const expected = Buffer.from(`Bearer ${token}`)
  const seen = new Map()
  const server = createServer(async (request, response) => {
    const fail = (status, message) => { if (!response.headersSent) response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message } })); else response.destroy() }
    const auth = Buffer.from(request.headers.authorization || '')
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return fail(401, 'Unauthorized')
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') return fail(404, 'Not found')
    const sessionId = request.headers['x-pac-session-id']
    const messageId = request.headers['x-pac-message-id']
    if (typeof sessionId !== 'string' || typeof messageId !== 'string' || !sessionId || !messageId || sessionId.length > 512 || messageId.length > 512 || /[\x00-\x1f]/.test(sessionId + messageId)) return fail(400, 'Missing OpenCode session or message identity')
    try {
      let size = 0
      const chunks = []
      for await (const chunk of request) {
        size += chunk.length
        if (size > maxBodyBytes) return fail(413, 'Request too large')
        chunks.push(chunk)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const last = Array.isArray(body.messages) ? body.messages.at(-1) : undefined
      if (body.stream !== true || typeof body.model !== 'string' || !body.model.startsWith('PAC_') || last?.role !== 'user' || typeof last.content !== 'string' || !last.content) return fail(400, 'Unsupported provider request')
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
      if (messages.has(messageId)) return fail(400, 'Duplicate turn; outcome may be unknown')
      if (messages.size >= 4096) return fail(503, 'Session turn capacity reached')
      messages.add(messageId)
      let completed = false
      const cancellation = new AbortController()
      response.on('close', () => { if (!completed) cancellation.abort() })
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const write = (delta, finish = null) => response.write(`data: ${JSON.stringify({ id: messageId, object: 'chat.completion.chunk', created: 0,
        model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
      write({ role: 'assistant' })
      const result = await router.prompt({ sessionId, model: body.model, cwd }, [{ type: 'text', text: last.content }], ({ method, params }) => {
        const update = params?.update
        if (method === 'session/update' && update?.sessionUpdate === 'available_commands_update') {
          write({ content: '[PAC: remote slash commands are not yet available in OpenCode.]\n' })
          return
        }
        if (method === '_auth/status_update') {
          write({ content: '[PAC: remote authentication status changed.]\n' })
          return
        }
        if (method === 'session/update' && update?.sessionUpdate === 'usage_update') {
          write({ content: '[PAC: remote usage metrics are not yet displayed.]\n' })
          return
        }
        if (method !== 'session/update' || update?.sessionUpdate !== 'agent_message_chunk' || update.content?.type !== 'text') throw new Error('Unsupported PAC event; turn cannot be represented')
        write({ content: update.content.text })
      }, { signal: cancellation.signal })
      if (result?.stopReason !== 'end_turn') throw new Error('PAC turn did not finish normally')
      write({}, 'stop')
      completed = true
      response.end('data: [DONE]\n\n')
    } catch (error) {
      const category = ['Selected PAC model is unavailable', 'PAC model selection was not confirmed', 'Unsupported ACP version',
        'ACP session identity is missing', 'ACP connection lost', 'ACP request timed out', 'Unsupported PAC event',
        'PAC turn did not finish normally'].find((value) => error?.message?.includes(value)) || 'other'
      const phase = ['initialize', 'session-new', 'select-model', 'prompt'].includes(error?.pacPhase) ? error.pacPhase : 'unknown'
      try { onFailure(`${category} (${phase})`) } catch {}
      fail(502, 'PAC turn failed or its outcome is unknown')
    }
  })
  return server
}
