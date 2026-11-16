import { createInterface } from 'node:readline'
const mode = process.env.TEST_MODE
const send = message => process.stdout.write(JSON.stringify(message) + '\n')
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  if (request.method === 'initialize') {
    if (mode === 'startup-hang') return
    if (mode === 'malformed') return process.stdout.write('not json\n')
    if (mode === 'oversized') return process.stdout.write('x'.repeat(17 * 1024 * 1024))
    send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } })
  } else if (request.method === 'tools/list') {
    if (mode === 'list-hang') return
    if (mode === 'list-disconnect') return process.exit(0)
    send({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'test', inputSchema: { type: 'object' } }] } })
    if (mode === 'approval-disconnect') setTimeout(() => process.exit(0), 50)
    if (mode === 'backpressure') process.stdin.pause()
  } else if (request.method === 'tools/call') {
    if (mode === 'call-disconnect') process.exit(0)
    else if (mode !== 'call-hang') send({ jsonrpc: '2.0', id: request.id, result: { content: [] } })
  }
})
