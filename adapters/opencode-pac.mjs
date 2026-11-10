import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createOpencodeProvider } from '../src/opencode-provider.mjs'
import { createOpencodeSessionRouter } from '../src/opencode-session-router.mjs'
import { openOpencodeAcpSession } from '../src/opencode-acp-session.mjs'
import { spawnContained, stopContained } from '../src/spawn-contained.mjs'

// Experimental launcher: text only, unsupported tools/events fail closed.
const binary = process.env.PAC_OPENCODE_BINARY
const model = process.env.PAC_MODEL
if (process.env.PAC_EXPERIMENTAL !== '1' || !binary || typeof model !== 'string' || !/^PAC_[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(model)) {
  throw new Error('Experimental PAC launcher requires PAC_EXPERIMENTAL=1, PAC_OPENCODE_BINARY and PAC_MODEL')
}
const cwd = process.cwd()
const token = randomBytes(32).toString('hex')
const routerPath = fileURLToPath(new URL('./pac-opencode-router.mjs', import.meta.url))
const pluginUrl = new URL('./opencode-plugin.mjs', import.meta.url).href
let server
const router = createOpencodeSessionRouter({ openSession: ({ sessionId, model: selected, cwd: workspace }) => openOpencodeAcpSession({
  command: process.execPath, args: [routerPath, 'acp'], cwd: workspace, model: selected, env: process.env,
  onPermission: (params) => server.requestPermission(sessionId, params),
  onDiagnostic: (category) => { if (process.env.PAC_DIAGNOSTICS === '1') process.stderr.write(`PAC ACP ${category}\n`) },
}) })
server = createOpencodeProvider({ router, token, cwd, onFailure: (category) => {
  if (process.env.PAC_DIAGNOSTICS === '1') process.stderr.write(`PAC provider failure: ${category}\n`)
} })
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
let child
try {
  let config = {}
  if (process.env.OPENCODE_CONFIG_CONTENT) config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT)
  if (!config || typeof config !== 'object' || Array.isArray(config) || config.provider?.pacbridge || (config.plugin && !Array.isArray(config.plugin))) throw new Error('PAC provider conflicts with existing OpenCode configuration')
  config = { ...config, plugin: [...(config.plugin || []), pluginUrl], provider: { ...(config.provider || {}), pacbridge: {
    npm: '@ai-sdk/openai-compatible', name: 'PAC Bridge (experimental)',
    options: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: token },
    models: { [model]: { name: model } },
  } } }
  const args = process.argv.slice(2)
  child = spawnContained(binary, args[0] === 'serve' ? args : ['--model', `pacbridge/${model}`, ...args], {
    cwd, env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      PAC_PROVIDER_URL: `http://127.0.0.1:${server.address().port}`, PAC_PROVIDER_TOKEN: token }, stdio: 'inherit', windowsHide: false,
  })
  process.once('SIGINT', () => { if (child) stopContained(child) })
  process.once('SIGTERM', () => { if (child) stopContained(child) })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  process.exitCode = code ?? 1
} finally {
  router.close()
  await new Promise((resolve) => server.close(resolve))
}
