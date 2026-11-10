import { Duplex } from 'node:stream'
import { once } from 'node:events'
import { createAcpPeer } from './acp-peer.mjs'
import { spawnContained, stopContained } from './spawn-contained.mjs'

// Discovery creates no user turn. The router probes each authorized PAC and
// reports offline endpoints separately from selectable model entries.
export async function discoverOpencodePacs({ command, args, cwd, env }) {
  if (typeof command !== 'string' || !command || !Array.isArray(args) || typeof cwd !== 'string' || !cwd) throw new Error('Invalid discovery launcher')
  const child = spawnContained(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  child.stderr.resume(); child.on('error', () => {})
  const peer = createAcpPeer(Duplex.from({ readable: child.stdout, writable: child.stdin }), {
    onRequest: async () => { throw new Error('Discovery cannot approve actions') },
    onNotification: () => {}, timeoutMs: 60000,
  })
  try {
    const initialized = await peer.call('initialize', { protocolVersion: 1, clientCapabilities: {} })
    if (initialized?.protocolVersion !== 1) throw new Error('Unsupported ACP version')
    const opened = await peer.call('session/new', { cwd, mcpServers: [] })
    const models = []
    for (const item of opened?.models?.availableModels || []) {
      if (typeof item?.modelId !== 'string' || !/^PAC_[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(item.modelId) || models.some((model) => model.id === item.modelId)) continue
      models.push({ id: item.modelId, name: typeof item.name === 'string' ? item.name.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 256) : item.modelId })
    }
    const warnings = (opened?._meta?.pacDiscoveryWarnings || []).filter((item) => typeof item?.name === 'string' &&
      /^[A-Za-z0-9_.-]{1,64}$/.test(item.name) && ['unavailable', 'source_setup_failed', 'rule_frontmatter_unsupported', 'external_import_unsupported'].includes(item.code))
      .map(({ name, code }) => ({ name, code }))
    return { models, warnings }
  } finally {
    peer.close()
    const exited = child.exitCode === null && child.signalCode === null ? once(child, 'close').catch(() => {}) : null
    stopContained(child)
    if (exited) await exited
  }
}
