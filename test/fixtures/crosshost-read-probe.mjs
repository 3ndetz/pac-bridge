import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectSource } from '../../src/acp-transport.mjs'
import { createWorkspace } from '../../src/acp-workspace.mjs'
import { openPacSession } from '../../src/pac-session.mjs'

const [url, tokenFile, cwd] = process.argv.slice(2)
const root = await mkdtemp(join(tmpdir(), 'pac-remote-read-'))
const file = join(root, 'fixture.txt')
await writeFile(file, 'PAC_CROSSHOST_READ_OK')
const token = (await readFile(tokenFile, 'utf8')).trim()
let stream
let session
let workspace
let answer = ''
let readCalls = 0
try {
  stream = await connectSource({ url, name: 'testpac', token })
  session = await openPacSession(stream, { cwd, timeoutMs: 60000, clientCapabilities: { fs: { readTextFile: true, writeTextFile: false } },
    onRequest: async (method, params) => {
      if (method === 'session/request_permission') {
        const option = params.options?.find((entry) => entry.kind === 'allow_once')
        if (!option) throw new Error('No one-time approval option')
        return { outcome: { outcome: 'selected', optionId: option.optionId } }
      }
      if (method !== 'fs/read_text_file' || !workspace || params.path !== file) throw new Error('Unexpected workspace request')
      readCalls++
      return workspace.readTextFile(params)
    },
    onNotification: (method, params) => {
      if (method === 'session/update' && params?.update?.sessionUpdate === 'agent_message_chunk') answer += params.update.content?.text || ''
    },
  })
  workspace = await createWorkspace({ root, sessionId: session.sessionId })
  const selected = session.models.models.find((model) => model.id === 'sonnet')
  if (!selected) throw new Error('Sonnet is unavailable')
  await session.selectModel(selected.id)
  await session.call('session/prompt', { prompt: [{ type: 'text', text: `Use the Read tool on this exact path: ${file}. Return the file contents exactly.` }] }, 120000)
  const verified = readCalls > 0 && answer.includes('PAC_CROSSHOST_READ_OK')
  process.stdout.write(JSON.stringify({ readCalls, replyVerified: verified }) + '\n')
  if (!verified) process.exitCode = 1
} finally { session?.close(); stream?.destroy(); await rm(root, { recursive: true, force: true }) }
