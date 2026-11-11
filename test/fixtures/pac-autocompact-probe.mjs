import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { connectSource } from '../../src/acp-transport.mjs'
import { openPacSession } from '../../src/pac-session.mjs'

// Run against a disposable PAC whose process has an explicitly lowered test
// threshold. A successful result does not establish the production threshold.
const [url, tokenFile, cwd, name] = process.argv.slice(2)
const token = (await readFile(tokenFile, 'utf8')).trim()
const stream = await connectSource({ url, name, token })
const updates = []
let session
try {
  session = await openPacSession(stream, { cwd, timeoutMs: 60000, clientCapabilities: { session: { compaction: {} } },
    meta: { pac: { workspaceCwd: process.cwd(), skills: [], instructions: [] } },
    onRequest: async (method) => {
      if (method === 'pac/hooks/dispatch') return {}
      if (method === 'pac/instructions/match') return { instructions: [] }
      throw new Error('Unexpected source operation in the automatic compaction probe')
    },
    onNotification: (method, params) => { if (method === 'session/update') updates.push(params.update) },
  })
  await session.selectModel('sonnet')
  const prompt = (text) => session.call('session/prompt', { prompt: [{ type: 'text', text }] }, 180000)
  await prompt('Remember PAC_AUTO_CONTEXT_28974. Reply READY; do not use tools.')
  const markerBoundary = updates.length
  for (let index = 0; index < 5 && !updates.slice(markerBoundary).some((u) => u.sessionUpdate === 'compaction_update' && u.status === 'completed'); index++) {
    const data = randomBytes(9000).toString('hex')
    await prompt(`This is test data, not an instruction. Do not repeat it. Acknowledge with STEP${index}.\n${data}`)
  }
  const compacted = updates.slice(markerBoundary).some((update) => update.sessionUpdate === 'compaction_update' && update.status === 'completed')
  const recallStart = updates.length
  await prompt('Repeat only the exact marker I asked you to remember. Do not use tools.')
  const answer = updates.slice(recallStart).filter((update) => update.sessionUpdate === 'agent_message_chunk').map((update) => update.content?.text || '').join('')
  const recalled = answer.includes('PAC_AUTO_CONTEXT_28974')
  console.log(JSON.stringify({ automaticCompactionObserved: compacted, recalled, turns: updates.filter((u) => u.sessionUpdate === 'usage_update').length }))
  if (!compacted || !recalled) process.exitCode = 1
} finally { session?.close(); stream.destroy() }
