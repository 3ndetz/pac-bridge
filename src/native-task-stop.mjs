export async function stopNativeTask(session, taskId) {
  if (typeof taskId !== 'string' || !taskId || !(session?.nativeSubagentRuntime?.children instanceof Map)) throw new Error('Native subagent task is unavailable')
  const matches = [...session.nativeSubagentRuntime.children.entries()].filter(([id, child]) => id === taskId || child.sessionId === taskId)
  if (matches.length !== 1) throw new Error(matches.length ? 'Ambiguous native subagent task in this session' : 'Unknown native subagent task in this session')
  const [nativeTaskId, task] = matches[0]
  if (task.terminalState !== undefined) return { status: task.terminalState, taskId }
  if (typeof session.query?.stopTask !== 'function') throw new Error('Native subagent cancellation is unavailable')
  await session.query.stopTask(nativeTaskId)
  return { status: 'stop_requested', taskId }
}
