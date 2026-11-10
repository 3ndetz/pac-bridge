import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { connectSource, startAgent } from '../../src/acp-transport.mjs'
import { openPacSession } from '../../src/pac-session.mjs'

const [claudeAcp, cwd] = process.argv.slice(2)
if (!claudeAcp || !cwd) throw new Error('Expected Claude ACP entrypoint and working directory')
const directory = await mkdtemp(join(tmpdir(), 'pac-claude-relay-'))
const reservation = createServer().listen(0, '127.0.0.1')
await once(reservation, 'listening')
const port = reservation.address().port
await new Promise((resolveClose) => reservation.close(resolveClose))
const sourceToken = randomBytes(32).toString('hex')
const agentToken = randomBytes(32).toString('hex')
const hash = (token) => createHash('sha256').update(token).digest('hex')
const tokens = join(directory, 'tokens.json')
await writeFile(tokens, JSON.stringify({ clients: { testpac: hash(agentToken) }, brains: { [hash(sourceToken)]: ['testpac'] } }))
const server = spawn(process.execPath, [resolve(fileURLToPath(new URL('../../server.js', import.meta.url)))], {
  env: { ...process.env, PORT: String(port), TOKENS: tokens, PAC_ACP_RELAY_ENABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
})
let agent
let source
let session
let answer = ''
try {
  const output = createInterface({ input: server.stdout })
  await once(output, 'line')
  const url = `ws://127.0.0.1:${port}`
  agent = await startAgent({ url, name: 'testpac', token: agentToken, command: process.execPath, args: [claudeAcp], cwd })
  source = await connectSource({ url, name: 'testpac', token: sourceToken })
  session = await openPacSession(source, { cwd, timeoutMs: 60000, onNotification: (method, params) => {
    if (method === 'session/update' && params?.update?.sessionUpdate === 'agent_message_chunk') answer += params.update.content?.text || ''
  } })
  const models = session.models.models
  const selected = models.find((model) => model.id === 'sonnet') || models[0]
  if (!selected) throw new Error('No models returned by Claude')
  const result = await session.selectModel(selected.id)
  const summary = { sessionCreated: true, modelCount: models.length, selectedModel: result.current }
  if (process.env.PAC_TEST_PROMPT === '1') {
    await session.call('session/prompt', { prompt: [{ type: 'text', text: 'Reply exactly PAC_RELAY_OK and nothing else.' }] }, 120000)
    summary.replyVerified = answer.includes('PAC_RELAY_OK')
    if (!summary.replyVerified) throw new Error('Claude reply did not contain the expected marker')
  }
  process.stdout.write(JSON.stringify(summary) + '\n')
  output.close()
} finally {
  session?.close()
  source?.destroy()
  agent?.close()
  server.kill()
  await once(server, 'close')
  await rm(directory, { recursive: true, force: true })
}
