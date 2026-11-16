const codes = new Set(['authentication', 'unauthorized', 'rate_limit', 'quota_exceeded', 'timeout', 'unavailable'])

export function classifyAgentErrors(messages) {
  const result = new Set()
  if (!Array.isArray(messages)) return []
  for (const message of messages) {
    const envelope = message?.content
    if (envelope?.role !== 'agent' || !['codex', 'event'].includes(envelope?.content?.type)) continue
    const event = envelope.content.data
    if (event?.type !== 'error') continue
    const code = typeof event.code === 'string' && codes.has(event.code) ? event.code : 'unknown'
    result.add(`${envelope.content.type === 'event' ? 'session-error' : 'agent-error'}:${code}`)
  }
  return [...result].sort()
}

export function createStageTimers(now = Date.now, origin = now()) {
  const start = origin, values = {}
  return {
    mark(stage) {
      if (!['prompt-accepted', 'source-start', 'source-start-approved', 'controller-call', 'mcp-call-approved', 'mcp-call', 'agent-error'].includes(stage)) throw new Error('Invalid diagnostic stage')
      if (!Object.hasOwn(values, stage)) values[stage] = Math.max(0, now() - start)
    },
    snapshot() { return { ...values } }
  }
}

export async function confirmArchive(id, request, readDatabase) {
  let postError
  try { await request(`/api/sessions/${id}/archive`, 'POST') } catch (error) { postError = error }
  try {
    const session = (await request(`/api/sessions/${id}`))?.session
    if (session?.metadata?.lifecycleState === 'archived' && session.active === false) return 'api'
  } catch {}
  const state = readDatabase(id)
  if (state?.lifecycleState === 'archived' && state.active === false) return 'database'
  throw Object.assign(new Error('Isolated HAPI archive unconfirmed'), { code: 'archive_unknown', cause: postError })
}


const startupStages = new Set(['provenance_start', 'provenance_allowed', 'approval_start', 'approval_allowed', 'connect_start', 'process_spawn', 'process_exit', 'connect_ready', 'connect_timeout', 'connect_cancelled', 'connect_error', 'list_start', 'list_ready', 'list_error'])
export function parseStartupTrace(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 65536) throw new Error('Invalid startup trace')
  const lines = text.split('\n').filter(Boolean)
  if (lines.length > 256) throw new Error('Invalid startup trace')
  return lines.map(line => {
    let item
    try { item = JSON.parse(line) } catch { throw new Error('Invalid startup trace') }
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).sort().join(',') !== 'elapsedMs,stage' || !startupStages.has(item.stage) || !Number.isSafeInteger(item.elapsedMs) || item.elapsedMs < 0 || item.elapsedMs > 7200000) throw new Error('Invalid startup trace')
    return { stage: item.stage, elapsedMs: item.elapsedMs }
  })
}


export function parseProvenanceTrace(text, sanitize) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 65536 || typeof sanitize !== 'function') throw new Error('Invalid provenance trace')
  const lines = text.split('\n').filter(Boolean)
  if (lines.length > 256) throw new Error('Invalid provenance trace')
  return lines.map(line => {
    let item
    try { item = JSON.parse(line) } catch { throw new Error('Invalid provenance trace') }
    const safe = sanitize(item)
    if (!safe || !Number.isSafeInteger(item.elapsedMs) || item.elapsedMs < 0 || item.elapsedMs > 7200000 || Object.keys(item).sort().join(',') !== [...Object.keys(safe), 'elapsedMs'].sort().join(',') || Object.keys(safe).some(key => safe[key] !== item[key])) throw new Error('Invalid provenance trace')
    return { ...safe, elapsedMs:item.elapsedMs }
  })
}
