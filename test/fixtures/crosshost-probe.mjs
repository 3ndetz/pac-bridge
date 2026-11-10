import { readFile } from 'node:fs/promises'
import { connectSource } from '../../src/acp-transport.mjs'
import { openPacSession } from '../../src/pac-session.mjs'

const [url, tokenFile, cwd] = process.argv.slice(2)
const token = (await readFile(tokenFile, 'utf8')).trim()
const stream = await connectSource({ url, name: 'testpac', token })
let session
let answer = ''
try {
  session = await openPacSession(stream, { cwd, timeoutMs: 60000, onNotification: (method, params) => {
    if (method === 'session/update' && params?.update?.sessionUpdate === 'agent_message_chunk') answer += params.update.content?.text || ''
  } })
  const models = session.models.models
  const model = models.find((entry) => entry.id === 'sonnet') || models[0]
  if (!model) throw new Error('Claude returned no models')
  const selection = await session.selectModel(model.id)
  await session.call('session/prompt', { prompt: [{ type: 'text', text: 'Reply exactly PAC_CROSSHOST_OK and nothing else.' }] }, 120000)
  if (!answer.includes('PAC_CROSSHOST_OK')) throw new Error('The Claude response did not contain the expected marker')
  process.stdout.write(JSON.stringify({ modelCount: models.length, selectedModel: selection.current, replyVerified: true }) + '\n')
} finally { session?.close(); stream.destroy() }
