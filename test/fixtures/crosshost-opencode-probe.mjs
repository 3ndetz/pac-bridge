import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { createAcpPeer } from '../../src/acp-peer.mjs'

const [url, tokenFile, remoteCwd] = process.argv.slice(2)
const binary = process.env.PAC_TEST_OPENCODE
if (!binary) throw new Error('PAC_TEST_OPENCODE must name the OpenCode executable')
const root = await mkdtemp(join(tmpdir(), 'pac-opencode-proof-'))
const file = join(root, 'fixture.txt')
await writeFile(file, 'PAC_ROUTER_INITIAL')
const router = fileURLToPath(new URL('./opencode-acp-router.mjs', import.meta.url))
const child = spawn(process.execPath, [router, 'acp'], { env: { ...process.env, PAC_EXPERIMENTAL: '1', PAC_OPENCODE_BINARY: binary,
  PAC_RELAY_URL: url, PAC_NAME: 'testpac', PAC_SOURCE_TOKEN_FILE: tokenFile, PAC_CONTROLLER_CWD: remoteCwd }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
let diagnostics = ''
child.stderr.on('data', (data) => { diagnostics += data.toString() })
const titles = []
const peer = createAcpPeer(Duplex.from({ readable: child.stdout, writable: child.stdin }), {
  timeoutMs: 60000,
  onRequest: async (method, params) => {
    if (method !== 'session/request_permission') throw new Error('Unexpected client request')
    if (!/^(Read|Write|Edit)\b/.test(params.toolCall?.title || '')) throw new Error('Unexpected permission request')
    const option = params.options?.find((entry) => entry.kind === 'allow_once')
    if (!option) throw new Error('No one-time approval option')
    return { outcome: { outcome: 'selected', optionId: option.optionId } }
  },
  onNotification: (method, params) => {
    if (method === 'session/update' && ['tool_call', 'tool_call_update'].includes(params?.update?.sessionUpdate) && params.update.title) titles.push(params.update.title)
  },
})
try {
  await peer.call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
  const session = await peer.call('session/new', { cwd: root, mcpServers: [] })
  const offered = session.models?.availableModels?.some((model) => model.modelId === 'PAC_testpac/sonnet')
  if (!offered) throw new Error('PAC model was not exposed in the OpenCode session')
  await peer.call('session/set_config_option', { sessionId: session.sessionId, configId: 'model', value: 'PAC_testpac/sonnet' })
  const prompt = `Use the Read tool on ${file}. Then use Write to set its content to PAC_ROUTER_OLD. Finally use Edit to replace PAC_ROUTER_OLD with PAC_ROUTER_NEW. Execute all three tools in that order.`
  await peer.call('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: prompt }] }, 120000)
  const contentsVerified = (await readFile(file, 'utf8')).trim() === 'PAC_ROUTER_NEW'
  const callsVerified = ['Read', 'Write', 'Edit'].every((tool) => titles.some((title) => title.startsWith(tool)))
  process.stdout.write(JSON.stringify({ modelOffered: offered, titles, contentsVerified, callsVerified }) + '\n')
  if (!contentsVerified || !callsVerified) process.exitCode = 1
} catch (error) {
  process.stderr.write(`${error.message}\n${diagnostics.slice(-1200)}\n`)
  process.exitCode = 1
} finally {
  peer.close()
  child.kill()
  await rm(root, { recursive: true, force: true })
}
