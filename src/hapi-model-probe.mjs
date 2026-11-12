import { isAbsolute } from 'node:path'
import { Duplex } from 'node:stream'
import { createAcpPeer } from './acp-peer.mjs'
import { discoverPacsDirect } from './pac-direct-discovery.mjs'
import { spawnContained, stopContained } from './spawn-contained.mjs'

export function mergeProbeModels(native, catalog) {
  if (!native || typeof native !== 'object' || Array.isArray(native) || !Array.isArray(catalog?.models)) throw new Error('Invalid model probe response')
  const result = structuredClone(native)
  const choices = catalog.models.map(({ id, name }) => ({ modelId: id, name }))
  const merge = (items, valueKey) => {
    const list = Array.isArray(items) ? [...items] : []
    for (const choice of choices) if (!list.some((item) => item?.[valueKey] === choice.modelId)) list.push(valueKey === 'value' ? { value: choice.modelId, name: choice.name } : choice)
    return list
  }
  const option = result.configOptions?.find((item) => item?.category === 'model' || item?.id === 'model')
  const fallback = (Array.isArray(result.availableModels) ? result.availableModels : Array.isArray(option?.options) ? option.options : [])
    .filter((item) => typeof (item?.modelId || item?.value) === 'string')
    .map((item) => ({ modelId: item.modelId || item.value, ...(typeof item.name === 'string' ? { name: item.name } : {}) }))
  if (Array.isArray(result.availableModels)) result.availableModels = merge(result.availableModels, 'modelId')
  result.models ??= {}
  result.models.availableModels = merge(Array.isArray(result.models.availableModels) && result.models.availableModels.length ? result.models.availableModels : fallback, 'modelId')
  if (option) option.options = merge(option.options, 'value')
  if (catalog.warnings?.length) result._meta = { ...(result._meta || {}), pacDiscoveryWarnings: catalog.warnings }
  return result
}

async function nativeModels({ binary, cwd, init, params, env }) {
  const child = spawnContained(binary, ['acp'], { cwd, env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  child.on('error', () => {})
  const native = createAcpPeer(Duplex.from({ readable: child.stdout, writable: child.stdin }), {
    onRequest: async () => { throw new Error('Model discovery cannot approve actions') }, onNotification: () => {},
  })
  try {
    const initialized = await native.call('initialize', init, 13000)
    if (initialized?.protocolVersion !== 1) throw new Error('Unsupported native OpenCode ACP version')
    return await native.call('session/new', params, 13000)
  } finally { native.close(); try { stopContained(child) } catch {} }
}

export function startHapiModelProbe({ input, output, binary, env = process.env, native = nativeModels, discover = discoverPacsDirect }) {
  if (!isAbsolute(binary)) throw new Error('Invalid native OpenCode path')
  let initialized, used = false
  const peer = createAcpPeer(Duplex.from({ readable: input, writable: output }), {
    onRequest: async (method, params) => {
      if (method === 'initialize') {
        if (initialized || params?.protocolVersion !== 1 || params?.clientInfo?.name !== 'hapi-opencode-models') throw new Error('Invalid HAPI model probe initialization')
        initialized = params
        return { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'PAC Bridge model probe', version: '1' } }
      }
      if (method !== 'session/new' || !initialized || used || !isAbsolute(params?.cwd || '') || !Array.isArray(params?.mcpServers) || params.mcpServers.length) throw new Error('Unsupported HAPI model probe request')
      used = true
      const [response, catalog] = await Promise.all([
        native({ binary, cwd: params.cwd, init: initialized, params, env }),
        Promise.resolve().then(() => discover({ cwd: params.cwd, env })).catch(() => ({ models: [], warnings: [{ name: 'configuration', code: 'unavailable' }] })),
      ])
      if (typeof response?.sessionId !== 'string' || !response.sessionId) throw new Error('Native OpenCode model probe did not return a session ID')
      for (const warning of catalog.warnings || []) process.stderr.write(`PAC ${warning.name}: ${warning.code}\n`)
      const exposed = env.PAC_NAMED_PROVIDERS_EXPERIMENT === '1' ? catalog : {
        ...catalog, models: catalog.models.map((item) => ({ ...item, id: `pacbridge/${item.id}` })),
      }
      const merged = mergeProbeModels(response, exposed)
      return merged
    },
  })
  input.once('end', () => peer.close())
  return peer
}
