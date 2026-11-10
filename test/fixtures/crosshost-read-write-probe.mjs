import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectSource } from '../../src/acp-transport.mjs'
import { createWorkspace } from '../../src/acp-workspace.mjs'
import { openPacSession } from '../../src/pac-session.mjs'

const [url, tokenFile, cwd] = process.argv.slice(2)
const root = await mkdtemp(join(tmpdir(), 'pac-remote-write-'))
const file = join(root, 'fixture.txt')
await writeFile(file, 'PAC_CROSSHOST_INITIAL')
const token = (await readFile(tokenFile, 'utf8')).trim()
let stream
let session
let workspace
let readCalls = 0
let writeCalls = 0
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
  })
  workspace = await createWorkspace({ root, sessionId: session.sessionId })
  await session.selectModel('sonnet')
  await session.call('session/prompt', { prompt: [{ type: 'text', text: `Use Read to read ${file}, then use Write to replace the file with exactly PAC_CROSSHOST_WRITTEN. Do not use other tools.` }] }, 120000)
  const verified = readCalls > 0 && writeCalls > 0 && (await readFile(file, 'utf8')).trim() === 'PAC_CROSSHOST_WRITTEN'
  process.stdout.write(JSON.stringify({ readCalls, writeCalls, contentsVerified: verified }) + '\n')
  if (!verified) process.exitCode = 1
} finally { session?.close(); stream?.destroy(); await rm(root, { recursive: true, force: true }) }
