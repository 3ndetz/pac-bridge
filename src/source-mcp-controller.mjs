import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { randomUUID } from 'node:crypto'

export function createControllerSourceMcp({ remoteSessionId, serverName, peer }) {
  if (typeof remoteSessionId !== 'string' || !remoteSessionId || typeof serverName !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(serverName) || typeof peer?.call !== 'function') throw new Error('Invalid source MCP controller binding')
  const instance = new McpServer({ name: 'source-mcp', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } })
  let closed = false
  const binding = () => { if (closed) throw new Error('Source MCP controller closed'); return { sessionId: remoteSessionId, server: serverName } }
  const forward = async (method, params, signal) => {
    const scoped = { ...binding(), ...params, operationId: randomUUID() }
    if (signal?.aborted) throw new Error('Source MCP operation cancelled')
    const abort = () => { try { void Promise.resolve(peer.call('pac/source_mcp/cancel', scoped)).catch(() => {}) } catch {} }
    signal?.addEventListener('abort', abort, { once: true })
    try { return await peer.call(method, scoped) } finally { signal?.removeEventListener('abort', abort) }
  }
  instance.server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => await forward('pac/source_mcp/list', {}, extra.signal))
  instance.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => await forward('pac/source_mcp/call', { name: request.params.name, arguments: request.params.arguments || {} }, extra.signal))
  return {
    config: { type: 'sdk', name: serverName, instance },
    async changed() { if (closed) throw new Error('Source MCP controller closed'); await instance.server.sendToolListChanged() },
    async close() { if (closed) return; closed = true; await instance.close() }
  }
}
