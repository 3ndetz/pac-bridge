// Capture only text emitted by a subagent belonging to this ACP session. The
// Claude SDK no longer provides its old native TaskOutput tool.
export function createNativeTaskOutput({ maxChars = 262144, maxTasks = 128 } = {}) {
  const outputs = new Map()
  function capture(rootSessionId, session, notification) {
    const update = notification?.update
    if (update?.sessionUpdate !== 'agent_message_chunk' || update.content?.type !== 'text' || typeof update.content.text !== 'string') return
    const children = session?.nativeSubagentsByTaskId
    if (!(children instanceof Map)) return
    const found = [...children].find(([, child]) => child.sessionId === notification.sessionId)
    if (!found) return
    const key = `${rootSessionId}\0${found[0]}`
    const old = outputs.get(key)
    const previous = old?.childSessionId === found[1].sessionId ? old : { childSessionId: found[1].sessionId, text: '', truncated: false }
    const text = previous.text + update.content.text
    outputs.delete(key)
    outputs.set(key, { childSessionId: found[1].sessionId, text: text.slice(0, maxChars), truncated: previous.truncated || text.length > maxChars })
    while (outputs.size > maxTasks) outputs.delete(outputs.keys().next().value)
  }
  async function get({ rootSessionId, session, taskId, block = true, timeoutMs = 120000, signal }) {
    if (typeof taskId !== 'string' || !taskId || !(session?.nativeSubagentsByTaskId instanceof Map)) throw new Error('Unknown native subagent task')
    const child = session.nativeSubagentsByTaskId.get(taskId)
    if (!child) throw new Error('Unknown native subagent task')
    const deadline = Date.now() + timeoutMs
    while (block && child.terminalState === undefined && Date.now() < deadline) {
      if (signal?.aborted) throw new Error('Task output request cancelled')
      await new Promise((resolve) => setTimeout(resolve, Math.min(200, Math.max(1, deadline - Date.now()))))
    }
    if (signal?.aborted) throw new Error('Task output request cancelled')
    const found = outputs.get(`${rootSessionId}\0${taskId}`)
    const result = found?.childSessionId === child.sessionId ? found : null
    return { taskId, status: child.terminalState ?? 'running', output: result?.text ?? '', truncated: result?.truncated ?? false,
      outputAvailable: Boolean(result) }
  }
  return { capture, get }
}

// The SDK stores child transcripts under their owning session. Validate the
// task against that session before reading; never search another session.
export async function recoverNativeTaskOutput({ sessionId, taskId, cwd, listSubagents, getSubagentMessages, maxChars = 262144 }) {
  if (typeof sessionId !== 'string' || !sessionId || typeof taskId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(taskId)) throw new Error('Unknown native subagent task')
  const ids = await listSubagents(sessionId, { dir: cwd })
  if (!Array.isArray(ids) || !ids.includes(taskId)) throw new Error('Unknown native subagent task')
  const messages = await getSubagentMessages(sessionId, taskId, { dir: cwd, limit: 1000 })
  if (!Array.isArray(messages)) throw new Error('Subagent output is unavailable')
  const text = messages.filter((entry) => entry?.type === 'assistant' && Array.isArray(entry.message?.content))
    .flatMap((entry) => entry.message.content.filter((item) => item?.type === 'text' && typeof item.text === 'string').map((item) => item.text)).join('')
  return { taskId, status: 'restored', output: text.slice(0, maxChars), truncated: text.length > maxChars, outputAvailable: Boolean(text), recovered: true }
}
