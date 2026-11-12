import { randomBytes } from 'node:crypto'
import { access } from 'node:fs/promises'
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
import { discoverPacsDirect } from '../src/pac-direct-discovery.mjs'
import { discoverOpencodePacs } from '../src/opencode-discovery.mjs'

// Experimental launcher: text only, unsupported tools/events fail closed.
const binary = process.env.PAC_OPENCODE_BINARY || (process.platform === 'win32' ? 'opencode.exe' : 'opencode')
let model = process.env.PAC_MODEL
if (process.env.PAC_EXPERIMENTAL !== '1' || (model && (model.length > 384 || !/^PAC_[A-Za-z0-9_.-]+\/[A-Za-z0-9_.:@/-]+$/.test(model)))) {
  throw new Error('Experimental PAC launcher requires PAC_EXPERIMENTAL=1 and a valid PAC_MODEL if specified')
}
const cwd = process.cwd()
const args = process.argv.slice(2)
const acpMode = args[0] === 'acp'
const namedProviders = process.env.PAC_NAMED_PROVIDERS_EXPERIMENT === '1'
const startedAt = Date.now()
const sessionRoot = resolve(process.env.PAC_SESSION_DIR || join(homedir(), '.pac-bridge', 'sessions'))
const token = randomBytes(32).toString('hex')
const routerPath = fileURLToPath(new URL('./pac-opencode-router.mjs', import.meta.url))
const pluginUrl = new URL('./opencode-plugin.mjs', import.meta.url).href
const shellCandidates = process.platform === 'win32'
  ? [process.env.PAC_SOURCE_BASH, process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
      process.env.ProgramFiles && join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe')]
  : [process.env.PAC_SOURCE_BASH, '/bin/bash', '/usr/bin/bash']
let sourceBash
for (const candidate of shellCandidates.filter(Boolean)) {
  try { await access(candidate); sourceBash = candidate; break } catch {}
}
if (!sourceBash) throw new Error('A local Bash executable is required for source project hooks and commands')
const routerEnv = { ...process.env, PAC_OPENCODE_BINARY: binary, PAC_SOURCE_BASH: sourceBash, PAC_EXPERIMENTAL_HOOKS: '1', PAC_EXPERIMENTAL_SKILLS: '1', PAC_EXPERIMENTAL_INSTRUCTIONS: '1' }
const catalog = process.env.PAC_DISCOVERY_ACP === '1'
  ? await discoverOpencodePacs({ command: process.execPath, args: [routerPath, 'acp'], cwd, env: routerEnv })
  : await discoverPacsDirect({ cwd, env: routerEnv })
if (process.env.PAC_DIAGNOSTICS === '1') process.stderr.write(`PAC discovery time: ${Date.now() - startedAt}ms\n`)
for (const warning of catalog.warnings) process.stderr.write(`PAC ${warning.name}: ${warning.code}\n`)
// A disconnected PAC must not prevent HAPI from starting OpenCode with its
// other providers. A specifically selected PAC model still fails closed.
if (!catalog.models.length && (!acpMode || model)) throw new Error('No authorized PAC models are available')
if (model && !catalog.models.some((entry) => entry.id === model)) throw new Error('The selected PAC model is unavailable')
if (!model && !acpMode) {
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
const legacyAcpStore = createSessionStore(join(sessionRoot, 'legacy-acp'))
const router = createOpencodeSessionRouter({ store: createSessionStore(join(sessionRoot, 'opencode')), journal: createOpencodeTurnJournal(join(sessionRoot, 'pending')),
  legacyStore: process.env.PAC_LEGACY_MIGRATION_EXPERIMENT === '1' ? createSessionStore(sessionRoot) : undefined,
  openSession: async ({ sessionId, model: selected, cwd: workspace, resumeSessionId, legacyBinding, legacyMode }) => {
  if (legacyBinding) {
    const existing = await legacyAcpStore.read(legacyBinding.sessionId)
    if (existing && JSON.stringify(existing) !== JSON.stringify(legacyBinding)) throw new Error('Existing migrated PAC binding does not match')
    if (!existing) await legacyAcpStore.write(legacyBinding)
  }
  return openOpencodeAcpSession({
  command: process.execPath, args: [routerPath, 'acp'], cwd: workspace, model: selected, resumeSessionId,
  env: { ...routerEnv, PAC_SESSION_DIR: join(sessionRoot, legacyMode ? 'legacy-acp' : 'acp') },
  onPermission: (params) => server.requestPermission(sessionId, params),
  onDiagnostic: (category) => { if (process.env.PAC_DIAGNOSTICS === '1') process.stderr.write(`PAC ACP ${category}\n`) },
}) } })
server = createOpencodeProvider({ router, token, cwd, onFailure: (category) => {
  if (process.env.PAC_DIAGNOSTICS === '1') process.stderr.write(`PAC provider failure: ${category}\n`)
} })
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
let child
try {
  let config = {}
  if (process.env.OPENCODE_CONFIG_CONTENT) config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT)
  if (!config || typeof config !== 'object' || Array.isArray(config) || config.command?.['pac-stop'] || (config.plugin && !Array.isArray(config.plugin))) throw new Error('PAC provider conflicts with existing OpenCode configuration')
  const providers = {}
  const options = { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: token }
  for (const entry of catalog.models) {
    const index = entry.id.indexOf('/')
    const providerId = namedProviders ? entry.id.slice(0, index) : 'pacbridge'
    const modelId = namedProviders ? entry.id.slice(index + 1) : entry.id
    if (config.provider?.[providerId]) throw new Error('PAC provider conflicts with existing OpenCode configuration')
    const [displayProvider, ...displayModel] = entry.name.split(' / ')
    providers[providerId] ??= { npm: '@ai-sdk/openai-compatible', name: namedProviders ? displayProvider : 'PAC Bridge (experimental)', options, models: {} }
    providers[providerId].models[modelId] = { name: namedProviders ? displayModel.join(' / ') || modelId : entry.name,
      ...(process.env.PAC_EXPERIMENTAL_IMAGE_INPUT === '1' ? { modalities: { input: ['text', 'image'], output: ['text'] } } : {}) }
  }
  config = { ...config, command: { ...(config.command || {}), 'pac-stop': { description: 'Stop a PAC background task by ID', template: 'PAC_BRIDGE_STOP_TASK $ARGUMENTS' } }, plugin: [...(config.plugin || []), pluginUrl], provider: { ...(config.provider || {}), ...providers } }
  child = spawnContained(binary, args[0] === 'serve' || acpMode ? args : ['--model', namedProviders ? model : `pacbridge/${model}`, ...args], {
    cwd, env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      PAC_PROVIDER_URL: `http://127.0.0.1:${server.address().port}`, PAC_PROVIDER_TOKEN: token,
      PAC_NAMED_PROVIDER_IDS: JSON.stringify(namedProviders ? Object.keys(providers) : []) }, stdio: acpMode ? ['pipe', 'pipe', 'inherit'] : 'inherit', windowsHide: false,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  })
  if (acpMode) {
    // The wrapper may have peeked at the first ACP request. Pipe the Node
    // stream so its replay buffer reaches OpenCode along with subsequent bytes.
    child.stdin.on('error', () => {})
    child.stdout.on('error', () => {})
    process.stdin.pipe(child.stdin)
    child.stdout.pipe(process.stdout)
  }
  process.once('SIGINT', () => { if (child) stopContained(child) })
  process.once('SIGTERM', () => { if (child) stopContained(child) })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  process.exitCode = code ?? 1
} finally {
  router.close()
  await new Promise((resolve) => server.close(resolve))
}
