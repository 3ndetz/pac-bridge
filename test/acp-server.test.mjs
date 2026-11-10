import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { connectSource, startAgent } from '../src/acp-transport.mjs'

test('existing PAC server relays a scoped ACP session', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pac-acp-server-'))
  const temporaryServer = createServer().listen(0, '127.0.0.1')
  await once(temporaryServer, 'listening')
  const port = temporaryServer.address().port
  await new Promise((resolve) => temporaryServer.close(resolve))
  const hash = (token) => createHash('sha256').update(token).digest('hex')
  const tokens = join(directory, 'tokens.json')
  await writeFile(tokens, JSON.stringify({ clients: { named: hash('agent-token'), other: hash('second-agent-token') }, brains: { [hash('source-token')]: ['named'], [hash('other-token')]: ['other'] } }))
  const server = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], {
    env: { ...process.env, PORT: String(port), TOKENS: tokens, PAC_ACP_RELAY_ENABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let agent
  let secondAgent
  let source
  let secondSource
  try {
    const output = createInterface({ input: server.stdout })
    await once(output, 'line')
    const url = `ws://127.0.0.1:${port}`
    await assert.rejects(startAgent({ url, name: 'other', token: 'agent-token', command: process.execPath, args: ['-e', 'process.stdin.pipe(process.stdout)'] }), /401/)
    agent = await startAgent({ url, name: 'named', token: 'agent-token', command: process.execPath, args: ['-e', 'process.stdin.pipe(process.stdout)'] })
    secondAgent = await startAgent({ url, name: 'other', token: 'second-agent-token', command: process.execPath, args: ['-e', 'process.stdin.on("data",data=>process.stdout.write("other:"+data))'] })
    await assert.rejects(connectSource({ url, name: 'named', token: 'other-token' }), /401/)
    await assert.rejects(connectSource({ url, name: 'other', token: 'source-token' }), /401/)
    source = await connectSource({ url, name: 'named', token: 'source-token' })
    const result = once(source, 'data')
    source.write('round trip\n')
    assert.equal((await result)[0].toString(), 'round trip\n')
    secondSource = await connectSource({ url, name: 'other', token: 'other-token' })
    const secondResult = once(secondSource, 'data')
    secondSource.write('round trip\n')
    assert.equal((await secondResult)[0].toString(), 'other:round trip\n')
    output.close()
  } finally {
    source?.destroy()
    secondSource?.destroy()
    agent?.close()
    secondAgent?.close()
    server.kill()
    await once(server, 'close')
    await rm(directory, { recursive: true, force: true })
  }
})
