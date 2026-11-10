const workspaceTools = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Skill']
const sourceTaskTools = ['TaskOutput', 'TaskStop']
const subagentTools = new Set(['Agent', 'Task', 'TaskOutput', 'TaskStop'])

export function prototypeToolDecision(name, { aliases = true, allowSubagents = false, allowQuestions = false, allowSourceMcp = false } = {}) {
  const supported = workspaceTools.some((tool) => name === (aliases ? `mcp__pac__${tool}` : tool)) ||
    sourceTaskTools.some((tool) => name === (aliases ? `mcp__pac__${tool}` : tool)) ||
    name === 'ToolSearch' || (allowSourceMcp && typeof name === 'string' && /^mcp__source_tools__[A-Za-z0-9_-]+$/.test(name)) ||
    (allowQuestions && name === (aliases ? 'mcp__pac__AskUserQuestion' : 'AskUserQuestion')) ||
    (allowSubagents && subagentTools.has(name))
  if (supported) return {}
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: `The PAC prototype cannot safely route ${typeof name === 'string' ? name : 'this tool'}.` } }
}
