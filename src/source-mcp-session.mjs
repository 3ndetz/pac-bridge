import { createHash, randomUUID } from 'node:crypto'
import { openLocalSourceMcp } from './source-mcp-local.mjs'

export function createSourceMcpSession({ sourceSessionId, remoteSessionId, cwd, resolveConfig, verifyProvenance, requestPermission, notify, open = openLocalSourceMcp }) {
  if (![sourceSessionId, remoteSessionId, cwd].every(value => typeof value === 'string' && value) ||
      [resolveConfig, verifyProvenance, requestPermission, notify, open].some(fn => typeof fn !== 'function')) throw new Error('Invalid source MCP session')
  const servers = new Map(), pending = new Map(), aborts = new Set(), operations = new Map(), seen = new Set()
  const lifetime = new AbortController()
  let closed = false, closing
  const digest = config => createHash('sha256').update(JSON.stringify(config)).digest('hex')
  async function snapshot() {
    if (closed) throw new Error('Source MCP session closed')
    let config, verified
    try { config = await resolveConfig(); verified = await verifyProvenance(config) } catch { await revoke(); throw new Error('Source MCP configuration unavailable') }
    if (closed || !config || typeof config !== 'object' || Array.isArray(config) || verified !== true) { await revoke(); throw new Error('Source MCP configuration unavailable') }
    return { config, revision: digest(config) }
  }
  function revoke() { return closing ??= closeSession() }
  async function closeSession() {
    closed = true
    lifetime.abort()
    for (const controller of aborts) controller.abort()
    const all = [...servers.values()]
    servers.clear()
    await Promise.all(all.map(item => item.client.close()))
  }
  async function current(revision) {
    const next = await snapshot()
    if (next.revision !== revision) { await revoke(); throw new Error('Source MCP configuration changed; session revoked') }
  }
  async function sessionServer(name, signal) {
    const state = await snapshot()
    const config = Object.hasOwn(state.config, name) ? state.config[name] : null
    if (!config || typeof config !== 'object') throw new Error('Source MCP server unavailable')
    const existing = servers.get(name)
    if (existing) { await current(existing.revision); return existing.client }
    if (pending.has(name)) throw new Error('Source MCP server is starting')
    const startupSignal = AbortSignal.any([signal, lifetime.signal])
    const promise = (async () => {
      const client = await open({ config, cwd, signal: startupSignal,
        verifyProvenance: async () => { await current(state.revision); return true },
        approveStart: async () => {
          const approved = await requestPermission({ sourceSessionId, kind: 'start', server: name, operationId: randomUUID(), signal: startupSignal })
          await current(state.revision)
          return approved === true
        },
        authorize: async ({ name: tool, arguments: args, signal }) => {
          const approved = await requestPermission({ sourceSessionId, kind: 'call', server: name, tool, arguments: args, operationId: randomUUID(), signal })
          await current(state.revision)
          return approved === true
        },
        onChanged: () => { if (!closed) notify({ sourceSessionId, server: name, type: 'tools_changed' }) }
      })
      try { await current(state.revision) } catch (error) { await client.close(); throw error }
      servers.set(name, { revision: state.revision, client })
      return client
    })()
    pending.set(name, { promise, revision: state.revision })
    try { return await promise } finally { pending.delete(name) }
  }
  return {
    async recheck() {
      const state = await snapshot()
      if ([...servers.values(), ...pending.values()].some(item => item.revision !== state.revision)) { await revoke(); throw new Error('Source MCP configuration changed; session revoked') }
    },
    async handle(method, params) {
      if (closed || !params || params.sessionId !== remoteSessionId || typeof params.server !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(params.server)) throw new Error('Source MCP session unavailable')
      if (typeof params.operationId !== 'string' || !/^[0-9a-f-]{36}$/.test(params.operationId)) throw new Error('Invalid source MCP operation')
      if (method === 'pac/source_mcp/cancel') {
        const operation = operations.get(params.operationId)
        if (!operation || operation.server !== params.server) return { cancelled: false }
        operation.controller.abort()
        if (operation.method === 'pac/source_mcp/list') await revoke()
        return { cancelled: true }
      }
      if (method !== 'pac/source_mcp/list' && (method !== 'pac/source_mcp/call' || typeof params.name !== 'string' || !params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments))) throw new Error('Unsupported source MCP request')
      if (seen.has(params.operationId) || seen.size >= 4096) throw new Error('Duplicate or unavailable source MCP operation')
      seen.add(params.operationId)
      const controller = new AbortController()
      aborts.add(controller)
      operations.set(params.operationId, { controller, server: params.server, method })
      try {
        const client = await sessionServer(params.server, controller.signal)
        if (closed || controller.signal.aborted) throw new Error('Source MCP session revoked')
        if (method === 'pac/source_mcp/list') return await client.list()
        return await client.call(params.name, params.arguments, { sourceSessionId }, { signal: controller.signal })
      } finally { aborts.delete(controller); operations.delete(params.operationId) }
    },
    close: revoke
  }
}
