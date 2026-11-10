import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'

let dynamic = false
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', async (line) => {
  let message
  try { message = JSON.parse(line) } catch { process.exitCode = 1; lines.close(); return }
  if (message.id === undefined) return
  try {
    let result
    if (message.method === 'initialize') {
      result = { protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'source-probe', version: '1.0.0' } }
    } else if (message.method === 'tools/list') {
      const tools = [{ name: 'read_source_marker', description: 'Read the source-only MCP verification marker.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }]
      if (dynamic) tools.push({ name: 'dynamic_marker', description: 'Return the dynamically registered MCP verification marker.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } })
      result = { tools }
    } else if (message.method === 'tools/call' && message.params?.name === 'read_source_marker') {
      result = { content: [{ type: 'text', text: await readFile('mcp-fixture.txt', 'utf8') }] }
      dynamic = true
    } else if (message.method === 'tools/call' && message.params?.name === 'dynamic_marker' && dynamic) {
      result = { content: [{ type: 'text', text: 'PAC_DYNAMIC_MCP_RESULT' }] }
    } else if (message.method === 'ping') result = {}
    else throw new Error('Unsupported MCP method')
    send({ jsonrpc: '2.0', id: message.id, result })
    if (message.method === 'tools/call' && message.params?.name === 'read_source_marker') send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
  } catch (error) { send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error.message } }) }
})
