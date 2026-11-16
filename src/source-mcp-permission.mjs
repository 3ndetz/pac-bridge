export function createSourceMcpPermission({ sourceSessionId, client }) {
  if (typeof sourceSessionId !== 'string' || !sourceSessionId || typeof client?.call !== 'function' || typeof client?.notify !== 'function') throw new Error('Invalid source MCP permission binding')
  return async function requestPermission({ sourceSessionId: session, kind, server, tool, arguments: args, operationId, signal }) {
    if (session !== sourceSessionId || !['start', 'call'].includes(kind) || typeof server !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(server) ||
        typeof operationId !== 'string' || !/^[0-9a-f-]{36}$/.test(operationId) ||
        (kind === 'call' && (typeof tool !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)))) throw new Error('Invalid source MCP permission request')
    if (signal?.aborted) throw new Error('Source MCP permission cancelled')
    const toolCallId = `pac-mcp-${operationId}`
    const params = { sessionId: sourceSessionId, toolCall: { toolCallId, title: kind === 'start' ? `Start source MCP: ${server}` : `Source MCP: ${server}/${tool}`,
      kind: 'other', rawInput: kind === 'start' ? { server } : { server, tool, arguments: args } },
      options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }, { optionId: 'deny', name: 'Reject', kind: 'reject_once' }] }
    let rejectAbort
    const cancelled = new Promise((_, reject) => { rejectAbort = reject })
    const abort = () => {
      try { client.notify('pac/permission/cancelled', { sessionId: sourceSessionId, toolCallId }) } catch {}
      rejectAbort(new Error('Source MCP permission cancelled'))
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      if (signal?.aborted) { abort(); return await cancelled }
      const result = await Promise.race([client.call('session/request_permission', params, 0), cancelled])
      return !signal?.aborted && result?.outcome?.outcome === 'selected' && result.outcome.optionId === 'allow'
    } finally { signal?.removeEventListener('abort', abort) }
  }
}
