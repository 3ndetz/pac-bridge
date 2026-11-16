import test from 'node:test'
import assert from 'node:assert/strict'
import { createSourceMcpSession } from '../src/source-mcp-session.mjs'
import { randomUUID } from 'node:crypto'

function fixture() {
  let config = { server: { type: 'local', command: ['secret-command'], enabled: true, environment: { TOKEN: 'secret-value' } } }
  let start = true, call = true, closes = 0, calls = 0, changed
  const prompts = [], notifications = []
  const open = async options => {
    await options.verifyProvenance()
    if (!await options.approveStart()) throw new Error('startup denied')
    changed = options.onChanged
    return {
      list: async () => ({ tools: [{ name: 'tool', inputSchema: { type: 'object' } }] }),
      call: async (name, args, context, { signal }) => {
        if (!await options.authorize({ name, arguments: args, signal })) throw new Error('call denied')
        calls++
        return { content: [{ type: 'text', text: context.sourceSessionId }] }
      },
      close: async () => { closes++ }
    }
  }
  const make = (sourceSessionId, remoteSessionId) => createSourceMcpSession({ sourceSessionId, remoteSessionId, cwd: 'source-workspace',
    resolveConfig: async () => structuredClone(config), verifyProvenance: async () => true,
    requestPermission: async request => { prompts.push(request); return request.kind === 'start' ? start : call },
    notify: event => notifications.push(event), open })
  return { make, prompts, notifications, setStart: value => { start = value }, setCall: value => { call = value },
    reconfigure: () => { config.server.command = ['changed'] }, change: () => changed(), closes: () => closes, calls: () => calls }
}
const list = id => ({ sessionId: id, server: 'server', operationId: randomUUID() })
const call = id => ({ ...list(id), name: 'tool', arguments: {} })

test('startup and call denial are independent and never disclose config', async () => {
  const f = fixture(), session = f.make('source-a', 'remote-a')
  f.setStart(false)
  await assert.rejects(session.handle('pac/source_mcp/list', list('remote-a')), /denied/)
  f.setStart(true); f.setCall(false)
  await session.handle('pac/source_mcp/list', list('remote-a'))
  await assert.rejects(session.handle('pac/source_mcp/call', call('remote-a')), /denied/)
  assert.equal(f.calls(), 0)
  assert.doesNotMatch(JSON.stringify(f.prompts), /secret-command|secret-value/)
  await session.close()
})

test('session ownership, dynamic notifications and reconfiguration fail closed', async () => {
  const f = fixture(), a = f.make('source-a', 'remote-a'), b = f.make('source-b', 'remote-b')
  await assert.rejects(a.handle('pac/source_mcp/list', list('remote-b')), /unavailable/)
  await Promise.all([a.handle('pac/source_mcp/list', list('remote-a')), b.handle('pac/source_mcp/list', list('remote-b'))])
  assert.equal((await a.handle('pac/source_mcp/call', call('remote-a'))).content[0].text, 'source-a')
  f.change()
  assert.deepEqual(f.notifications, [{ sourceSessionId: 'source-b', server: 'server', type: 'tools_changed' }])
  f.reconfigure()
  await assert.rejects(a.handle('pac/source_mcp/call', call('remote-a')), /changed/)
  await assert.rejects(a.handle('pac/source_mcp/list', list('remote-a')), /unavailable/)
  assert.equal(f.closes(), 1)
  await b.close(); await a.close()
  assert.equal(f.closes(), 2)
})

test('revocation aborts a pending start approval and does not launch a server', async () => {
  let release, launches = 0
  const session = createSourceMcpSession({ sourceSessionId: 'a', remoteSessionId: 'b', cwd: 'workspace',
    resolveConfig: async () => ({ server: {} }), verifyProvenance: async () => true, notify: () => {},
    requestPermission: ({ signal }) => new Promise((resolve, reject) => { release = resolve; signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }) }),
    open: async options => { if (await options.approveStart()) launches++; throw new Error('should not launch') } })
  const pending = session.handle('pac/source_mcp/list', list('b'))
  await new Promise(resolve => setImmediate(resolve))
  const rejected = assert.rejects(pending, /cancelled|closed/)
  await session.close()
  release(true)
  await rejected
  assert.equal(launches, 0)
})

test('a scoped cancel revokes pending approval and rejects replay', async () => {
  let ready
  const waiting = new Promise(resolve => { ready = resolve })
  const session = createSourceMcpSession({ sourceSessionId: 'a', remoteSessionId: 'b', cwd: 'workspace',
    resolveConfig: async () => ({ server: {} }), verifyProvenance: async () => true, notify: () => {},
    requestPermission: ({ signal }) => new Promise((_, reject) => { signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); ready() }),
    open: async options => { await options.approveStart(); throw new Error('should not launch') } })
  const params = list('b')
  const work = session.handle('pac/source_mcp/list', params)
  const rejected = assert.rejects(work, /cancelled|closed/)
  await waiting
  assert.deepEqual(await session.handle('pac/source_mcp/cancel', params), { cancelled: true })
  await rejected
  await assert.rejects(session.handle('pac/source_mcp/list', params), /unavailable/)
  await session.close()
})
