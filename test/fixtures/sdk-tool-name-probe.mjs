import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [sdkRoot, cwd] = process.argv.slice(2)
if (!sdkRoot || !cwd) throw new Error('Expected SDK package root and isolated working directory')
const require = createRequire(join(sdkRoot, 'package.json'))
const { query, tool, createSdkMcpServer } = await import(pathToFileURL(require.resolve('@anthropic-ai/claude-agent-sdk')).href)
const { z } = require('zod')
const seenTools = []
const seenHooks = []
const taskEvents = []
let backgroundAgent = false
const aliased = process.env.PAC_TEST_ALIASES === '1'
const subagent = process.env.PAC_TEST_SUBAGENT === '1'
const background = process.env.PAC_TEST_BACKGROUND === '1'
let invoked = false
let answer = ''
const paths = []
const server = createSdkMcpServer({ name: 'pac', version: '1.0.0', tools: [tool('Read', 'Read a file from the client workspace.', { file_path: z.string() }, async (input) => {
  invoked = true
  paths.push(input.file_path)
  return { content: [{ type: 'text', text: 'PAC_SDK_READ_PROBE_OK' }] }
})] })

for await (const event of query({ prompt: background ? 'Use the Agent tool to start a subagent with run_in_background=true. Instruct it to call Read on /workspace/fixture.txt and return the exact content. Wait for its result and then reply with that content.' : subagent ? 'Use the Agent tool to start a subagent. Instruct that subagent to call Read on /workspace/fixture.txt and return the exact content; then reply with that content.' : 'Call the Read tool for /workspace/fixture.txt and then reply with the exact content it returns.', options: {
  cwd, tools: subagent ? ['Agent', 'Read', 'TaskOutput', 'TaskStop'] : process.env.PAC_KEEP_BUILTINS === '1' ? { type: 'preset', preset: 'claude_code' } : [], mcpServers: { pac: server }, allowedTools: ['Read', 'mcp__pac__Read', 'Agent', 'TaskOutput', 'TaskStop'], permissionMode: 'bypassPermissions',
  ...(aliased ? { toolAliases: { Read: 'mcp__pac__Read' } } : {}),
  allowDangerouslySkipPermissions: true, maxTurns: background ? 8 : 3, model: 'sonnet', settingSources: [],
  hooks: {
    PreToolUse: [{ matcher: '.*', hooks: [async (input) => { seenHooks.push(`pre:${input.tool_name}`); return {} }] }],
    PostToolUse: [{ matcher: '.*', hooks: [async (input) => { seenHooks.push(`post:${input.tool_name}`); return {} }] }],
  },
} })) {
  if (event.type === 'assistant') for (const block of event.message.content || []) {
    if (block.type === 'tool_use') {
      seenTools.push(block.name)
      if (block.name === 'Agent' && block.input?.run_in_background === true) backgroundAgent = true
    }
    if (block.type === 'text') answer += block.text
  }
  if (event.type === 'system' && typeof event.subtype === 'string' && event.subtype.startsWith('task_')) taskEvents.push(event.subtype)
  if (event.type === 'result' && event.is_error) throw new Error(`SDK query failed: ${event.subtype}`)
}
process.stdout.write(JSON.stringify({ invoked, paths, seenTools, seenHooks, backgroundAgent, taskEvents, replyVerified: answer.includes('PAC_SDK_READ_PROBE_OK') }) + '\n')
if (!invoked || !answer.includes('PAC_SDK_READ_PROBE_OK') || !seenHooks.some((name) => name.startsWith('pre:')) || !seenHooks.some((name) => name.startsWith('post:')) || (subagent && !seenTools.includes('Agent')) || (background && !backgroundAgent)) process.exitCode = 1
