import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { createOpencodeProvider } from '../src/opencode-provider.mjs'
import { createOpencodeSessionRouter } from '../src/opencode-session-router.mjs'
import { openOpencodeAcpSession } from '../src/opencode-acp-session.mjs'
import { spawnContained, stopContained } from '../src/spawn-contained.mjs'
import { createSessionStore } from '../src/session-store.mjs'
import { createOpencodeTurnJournal } from '../src/opencode-turn-journal.mjs'
import { discoverOpencodePacs } from '../src/opencode-discovery.mjs'

// Experimental launcher: text only, unsupported tools/events fail closed.
const binary = process.env.PAC_OPENCODE_BINARY
let model = process.env.PAC_MODEL
if (process.env.PAC_EXPERIMENTAL !== '1' || !binary || (model && !/^PAC_[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(model))) {
  throw new Error('Experimental PAC launcher requires PAC_EXPERIMENTAL=1, PAC_OPENCODE_BINARY and a valid PAC_MODEL if specified')
}
const cwd = process.cwd()
const sessionRoot = resolve(process.env.PAC_SESSION_DIR || join(homedir(), '.pac-bridge', 'sessions'))
const token = randomBytes(32).toString('hex')
const routerPath = fileURLToPath(new URL('./pac-opencode-router.mjs', import.meta.url))
const pluginUrl = new URL('./opencode-plugin.mjs', import.meta.url).href
const catalog = await discoverOpencodePacs({ command: process.execPath, args: [routerPath, 'acp'], cwd, env: process.env })
for (const warning of catalog.warnings) process.stderr.write(`PAC ${warning.name}: ${warning.code}\n`)
if (!catalog.models.length) throw new Error('No authorized PAC models are available')
if (model && !catalog.models.some((entry) => entry.id === model)) throw new Error('The selected PAC model is unavailable')
if (!model) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Select a PAC model with PAC_MODEL in non-interactive mode')
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    catalog.models.forEach((entry, index) => process.stdout.write(`${index + 1}. ${entry.id} — ${entry.name.replace(/[\x00-\x1f\x7f]/g, ' ')}\n`))
    const selected = Number(await prompt.question('PAC model number: '))
    if (!Number.isSafeInteger(selected) || selected < 1 || selected > catalog.models.length) throw new Error('No valid PAC model selected')
    model = catalog.models[selected - 1].id
  } finally { prompt.close() }
}
let server
const router = createOpencodeSessionRouter({ store: createSessionStore(join(sessionRoot, 'opencode')), journal: createOpencodeTurnJournal(join(sessionRoot, 'pending')),
  openSession: ({ sessionId, model: selected, cwd: workspace, resumeSessionId }) => openOpencodeAcpSession({
  command: process.execPath, args: [routerPath, 'acp'], cwd: workspace, model: selected, resumeSessionId,
  env: { ...process.env, PAC_SESSION_DIR: join(sessionRoot, 'acp') },
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
    models: Object.fromEntries(catalog.models.map((entry) => [entry.id, { name: entry.name }])),
  } } }
  const args = process.argv.slice(2)
  child = spawnContained(binary, args[0] === 'serve' ? args : ['--model', `pacbridge/${model}`, ...args], {
    cwd, env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      PAC_PROVIDER_URL: `http://127.0.0.1:${server.address().port}`, PAC_PROVIDER_TOKEN: token }, stdio: 'inherit', windowsHide: false,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  })
  process.once('SIGINT', () => { if (child) stopContained(child) })
  process.once('SIGTERM', () => { if (child) stopContained(child) })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  process.exitCode = code ?? 1
} finally {
  router.close()
  await new Promise((resolve) => server.close(resolve))
}
