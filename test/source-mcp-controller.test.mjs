import test from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { createControllerSourceMcp } from '../src/source-mcp-controller.mjs'

test('controller MCP instance routes only the bound remote session and forwards catalog updates', async () => {
  const calls = [], events = []
  const bridge = createControllerSourceMcp({ remoteSessionId: 'remote-a', serverName: 'source_server', peer: { call: async (method, params) => {
    calls.push({ method, params })
    return method.endsWith('/list') ? { tools: [{ name: 'tool', inputSchema: { type: 'object' } }] } : { content: [{ type: 'text', text: 'ok' }] }
  } } })
  const client = new Client({ name: 'test', version: '1' })
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => events.push('changed'))
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([bridge.config.instance.connect(a), client.connect(b)])
  try {
    assert.equal((await client.listTools()).tools[0].name, 'tool')
    assert.equal((await client.callTool({ name: 'tool', arguments: { value: 1 } })).content[0].text, 'ok')
    assert.equal(calls[0].params.sessionId, 'remote-a')
    assert.equal(calls[1].params.server, 'source_server')
    await bridge.changed()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(events, ['changed'])
  } finally { await client.close(); await bridge.close(); await bridge.close() }
})
