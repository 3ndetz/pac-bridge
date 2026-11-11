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
    const previous = outputs.get(key) || { text: '', truncated: false }
    const text = previous.text + update.content.text
    outputs.delete(key)
    outputs.set(key, { text: text.slice(0, maxChars), truncated: previous.truncated || text.length > maxChars })
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
    const result = outputs.get(`${rootSessionId}\0${taskId}`) || { text: '', truncated: false }
    return { taskId, status: child.terminalState ?? 'running', output: result.text, truncated: result.truncated }
  }
  return { capture, get }
}
