export function inspectPacMessages(messages, marker) {
  let category = null
  for (const entry of Array.isArray(messages) ? messages : []) {
    const content = entry?.content
    if (content?.role !== 'agent') continue
    const data = content?.content?.data
    if (data?.type === 'error') {
      const value = typeof data.message === 'string' ? data.message.toLowerCase() : ''
      const next = value.includes('authentication failed') || value.includes('authentication-related error') ? 'authentication_related'
        : /timed?\s*out|deadline/.test(value) ? 'timeout'
        : /econnrefused|econnreset|network|connection/.test(value) ? 'connection_failed'
        : 'agent_error'
      if (!category || next === 'authentication_related' || (category === 'agent_error' && next !== 'agent_error')) category = next
    }
  }
  if (category) return { kind: 'error', category }
  for (const entry of Array.isArray(messages) ? messages : []) {
    const content = entry?.content, data = content?.content?.data
    if (content?.role === 'agent' && data?.type === 'message' && typeof data.message === 'string' && data.message.includes(marker)) return { kind: 'success' }
  }
  return null
}
