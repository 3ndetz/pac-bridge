import { createHmac } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { win32 } from 'node:path'

const keys = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'NODE_EXTRA_CA_CERTS']
const paths = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'CLAUDE_CONFIG_DIR']
const digest = (key, value) => createHmac('sha256', key).update(value).digest('hex')

export async function currentPrincipal() {
  if (process.platform !== 'win32') return typeof process.getuid === 'function' ? `uid:${process.getuid()}` : null
  try {
    const { stdout } = await promisify(execFile)('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 5000, maxBuffer: 8192 })
    const matches = stdout.match(/S-1-(?:\d+-)*\d+/g)
    return matches?.length === 1 ? `sid:${matches[0]}` : null
  } catch { return null }
}

export function captureComparison({ key, principal, env, sdkModel, route }) {
  if (!Buffer.isBuffer(key) || key.length < 32) throw new Error('Comparison key required')
  const fingerprint = (kind, value) => typeof value === 'string' && value.length ? digest(key, `${kind}\0${value}`) : null
  const presence = Object.fromEntries(keys.map(name => [name, Object.hasOwn(env, name)]))
  const homes = Object.fromEntries(paths.map(name => [name, fingerprint('path', typeof env[name] === 'string' && env[name] ? win32.normalize(env[name]).toLowerCase() : null)]))
  return { comparisonKey: digest(key, 'comparison-key-check'), principal: fingerprint('principal', principal), homes, presence, sdkModel: fingerprint('sdk-model', sdkModel), route: ['remote-relay', 'local-mock', 'direct-acp'].includes(route) ? route : 'unknown' }
}

export function compareCaptures(a, b) {
  if (!a.comparisonKey || a.comparisonKey !== b.comparisonKey) throw new Error('Comparison keys differ')
  const equal = (x, y) => x && y ? x === y : null
  return { principal: equal(a.principal, b.principal), homes: Object.fromEntries(paths.map(name => [name, equal(a.homes[name], b.homes[name])])), presence: Object.fromEntries(keys.map(name => [name, a.presence[name] === b.presence[name]])), sdkModel: equal(a.sdkModel, b.sdkModel), route: a.route === 'unknown' || b.route === 'unknown' ? null : a.route === b.route }
}
