import { access, readFile, realpath } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

// This launcher only adds a provider to the HAPI runner that starts it. It
// does not create, replace, restart, or configure a HAPI hub or runner.
const base = join(homedir(), '.local', 'share', 'pac-bridge')
const readText = async name => (await readFile(join(base, name), 'utf8')).trim()
const binary = await readText('opencode-path')
if (!isAbsolute(binary) || resolve(binary) === resolve(join(base, 'bin', 'opencode')) ||
    await realpath(binary) === await realpath(join(base, 'bin', 'opencode'))) throw new Error('Invalid PAC Bridge installation')
async function launch(command, args, env) {
  const child = spawn(command, args, { env, stdio: 'inherit' })
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal))
  process.exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolveExit(code ?? (signal ? 1 : 0)))
  })
}
if (process.argv[2] !== 'acp') {
  await launch(binary, process.argv.slice(2), process.env)
} else {
let prepared
try {
const [revision, keys] = await Promise.all(['current', 'connection-directory'].map(readText))
if (!/^[a-f0-9]{40}$/.test(revision) || !isAbsolute(keys)) throw new Error('Invalid PAC Bridge installation')
const config = JSON.parse((await readFile(join(keys, 'connection.json'), 'utf8')).replace(/^\uFEFF/, ''))
if (!config || typeof config.relayUrl !== 'string' || !/^wss:\/\/[^/]+$/.test(config.relayUrl) ||
    typeof config.pacName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(config.pacName) ||
    typeof config.controllerCwd !== 'string' || !config.controllerCwd || /[\x00-\x1f\x7f]/.test(config.controllerCwd)) throw new Error('Invalid PAC connection settings')
for (const key of ['displayName', 'modelPrefix']) if (config[key] !== undefined &&
    (typeof config[key] !== 'string' || !config[key].trim() || config[key].length > (key === 'modelPrefix' ? 32 : 64) || /[\x00-\x1f\x7f]/.test(config[key]))) throw new Error('Invalid PAC connection label')
const cert = join(keys, 'pac-relay-ca.pem'), token = join(keys, 'pac-source-token.txt')
const adapter = join(base, 'versions', revision, 'adapters', 'pac-hapi-opencode.mjs')
await Promise.all([binary, cert, token, adapter].map(path => access(path)))
if (process.env.NODE_EXTRA_CA_CERTS && resolve(process.env.NODE_EXTRA_CA_CERTS) !== resolve(cert)) throw new Error('Existing NODE_EXTRA_CA_CERTS conflicts with the PAC relay CA')
const env = { ...process.env, PAC_EXPERIMENTAL: '1', PAC_HAPI_PROVIDER_EXPERIMENT: '1', PAC_NAMED_PROVIDERS_EXPERIMENT: '1',
  PAC_OPENCODE_BINARY: binary, PAC_RELAY_URL: config.relayUrl, PAC_NAME: config.pacName, PAC_CONTROLLER_CWD: config.controllerCwd,
  PAC_SOURCE_TOKEN_FILE: token, NODE_EXTRA_CA_CERTS: cert, PAC_SESSION_DIR: join(base, 'bindings') }
if (config.displayName) env.PAC_DISPLAY_NAME = config.displayName; else delete env.PAC_DISPLAY_NAME
if (config.modelPrefix) env.PAC_MODEL_PREFIX = config.modelPrefix; else delete env.PAC_MODEL_PREFIX
prepared = { adapter, env }
} catch {
  // Native OpenCode remains available if the PAC profile or CA is missing or
  // invalid. No PAC model is exposed and no user operation is replayed.
  process.stderr.write('PAC Bridge configuration is unavailable; starting native OpenCode.\n')
}
if (prepared) await launch(process.execPath, [prepared.adapter, ...process.argv.slice(2)], prepared.env)
else await launch(binary, process.argv.slice(2), process.env)
}
