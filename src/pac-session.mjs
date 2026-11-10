import { createAcpPeer } from './acp-peer.mjs'

function modelOptions(response) {
  const option = response.configOptions?.find((entry) => entry.category === 'model' || entry.id === 'model')
  const values = option?.options?.flatMap((entry) => Array.isArray(entry.options) ? entry.options : [entry])
  if (values?.length) return { configId: option.id, current: option.currentValue, models: values.map((model) => ({ id: model.value, name: model.name })) }
  if (response.models?.availableModels) return { current: response.models.currentModelId, models: response.models.availableModels.map((model) => ({ id: model.modelId, name: model.name })) }
  return { current: undefined, models: [] }
}

export async function openPacSession(stream, { cwd, clientCapabilities = {}, meta, onRequest, onNotification, timeoutMs = 30000, resumeSessionId }) {
  if (typeof cwd !== 'string' || !cwd) throw new Error('A PAC working directory is required')
  if (resumeSessionId !== undefined && (typeof resumeSessionId !== 'string' || !resumeSessionId)) throw new Error('Invalid PAC resume identity')
  const peer = createAcpPeer(stream, { onRequest, onNotification, timeoutMs })
  try {
    const initialization = await peer.call('initialize', { protocolVersion: 1, clientCapabilities })
    if (initialization?.protocolVersion !== 1) throw new Error('Unsupported PAC ACP version')
    if (resumeSessionId && initialization.agentCapabilities?.loadSession !== true) throw new Error('PAC cannot load an existing session')
    const response = await peer.call(resumeSessionId ? 'session/load' : 'session/new', {
      cwd, mcpServers: [], ...(resumeSessionId ? { sessionId: resumeSessionId } : {}), ...(meta ? { _meta: meta } : {})
    })
    const opened = { ...response, sessionId: response?.sessionId ?? resumeSessionId }
    if (typeof opened.sessionId !== 'string' || !opened.sessionId) throw new Error('PAC did not return a session identity')
    if (resumeSessionId && opened.sessionId !== resumeSessionId) throw new Error('PAC returned a different session identity')
    let catalog = modelOptions(opened)
    return {
      sessionId: opened.sessionId,
      get models() { return { current: catalog.current, models: structuredClone(catalog.models) } },
      async selectModel(modelId) {
        if (!catalog.models.some((model) => model.id === modelId)) throw new Error('Model is unavailable in this PAC session')
        if (!catalog.configId) throw new Error('PAC does not expose a verifiable model configuration option')
        const result = await peer.call('session/set_config_option', { sessionId: opened.sessionId, configId: catalog.configId, value: modelId })
        const updated = modelOptions(result || {})
        if (!updated.models.length || updated.current !== modelId) throw new Error('PAC did not confirm the selected model')
        catalog = updated
        return { current: catalog.current, models: structuredClone(catalog.models) }
      },
      call(method, params = {}, timeout) { return peer.call(method, { ...params, sessionId: opened.sessionId }, timeout) },
      notify(method, params = {}) { peer.notify(method, { ...params, sessionId: opened.sessionId }) },
      close() { peer.close() },
    }
  } catch (error) { peer.close(); throw error }
}
