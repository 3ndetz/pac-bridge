import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectSource } from '../../src/acp-transport.mjs'
import { createWorkspace } from '../../src/acp-workspace.mjs'
import { openPacSession } from '../../src/pac-session.mjs'

const [url, tokenFile, cwd] = process.argv.slice(2)
const root = await mkdtemp(join(tmpdir(), 'pac-remote-edit-'))
const file = join(root, 'fixture.txt')
await writeFile(file, 'before PAC_EDIT_OLD after')
const token = (await readFile(tokenFile, 'utf8')).trim()
let stream
let session
let workspace
let readCalls = 0
let writeCalls = 0
const toolTitles = []
try {
  stream = await connectSource({ url, name: 'testpac', token })
  session = await openPacSession(stream, { cwd, timeoutMs: 60000, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    onRequest: async (method, params) => {
      if (method === 'session/request_permission') {
        const option = params.options?.find((entry) => entry.kind === 'allow_once')
        if (!option) throw new Error('No one-time approval option')
        return { outcome: { outcome: 'selected', optionId: option.optionId } }
      }
      if (!workspace || params.path !== file) throw new Error('Unexpected workspace request')
      if (method === 'fs/read_text_file') { readCalls++; return workspace.readTextFile(params) }
      if (method === 'fs/write_text_file') { writeCalls++; return workspace.writeTextFile(params) }
      throw new Error('Unsupported workspace request')
    },
    onNotification: (method, params) => {
      if (method === 'session/update' && params?.update?.sessionUpdate === 'tool_call') toolTitles.push(params.update.title || '')
    },
  })
  workspace = await createWorkspace({ root, sessionId: session.sessionId })
  await session.selectModel('sonnet')
  await session.call('session/prompt', { prompt: [{ type: 'text', text: `Use the Edit tool to replace PAC_EDIT_OLD with PAC_EDIT_NEW in ${file}. Do not use Write.` }] }, 120000)
  const verified = readCalls > 0 && writeCalls > 0 && toolTitles.some((title) => /^edit\b/i.test(title)) && await readFile(file, 'utf8') === 'before PAC_EDIT_NEW after'
  process.stdout.write(JSON.stringify({ readCalls, writeCalls, toolTitles, contentsVerified: verified }) + '\n')
  if (!verified) process.exitCode = 1
} finally { session?.close(); stream?.destroy(); await rm(root, { recursive: true, force: true }) }
