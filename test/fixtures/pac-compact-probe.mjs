import { readFile } from 'node:fs/promises'
import { connectSource } from '../../src/acp-transport.mjs'
import { openPacSession } from '../../src/pac-session.mjs'

const [url, tokenFile, cwd] = process.argv.slice(2)
const token = (await readFile(tokenFile, 'utf8')).trim()
const stream = await connectSource({ url, name: 'testpac', token })
const updates = []
let session
try {
  session = await openPacSession(stream, { cwd, timeoutMs: 60000, clientCapabilities: { session: { compaction: {} } }, meta: { pac: { workspaceCwd: process.cwd(), skills: [], instructions: [] } },
    onRequest: async () => { throw new Error('Unexpected tool request') },
    onNotification: (method, params) => { if (method === 'session/update') updates.push(params.update) },
  })
  await session.selectModel('sonnet')
  const prompt = (text) => session.call('session/prompt', { prompt: [{ type: 'text', text }] }, 180000)
  await prompt('Remember PAC_DIRECT_COMPACT_41829 for a later question. Reply READY.')
  const before = updates.length
  await prompt('/compact')
  const compact = updates.slice(before)
  const done = compact.some((update) => update.sessionUpdate === 'compaction_update' && update.status === 'completed')
  const recallStart = updates.length
  await prompt('What marker did I ask you to remember? Reply with only the exact marker.')
  const recalled = updates.slice(recallStart).filter((update) => update.sessionUpdate === 'agent_message_chunk').map((update) => update.content?.text || '').join('').includes('PAC_DIRECT_COMPACT_41829')
  console.log(JSON.stringify({ compactEvents: compact.map((update) => ({ type: update.sessionUpdate, status: update.status })), completed: done, recalled }))
  if (!done || !recalled) process.exitCode = 1
} finally { session?.close(); stream.destroy() }
