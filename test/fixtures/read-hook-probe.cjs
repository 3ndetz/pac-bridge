const fs = require('node:fs')

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { input += chunk })
process.stdin.on('end', () => {
  const event = JSON.parse(input)
  if (event.hook_event_name === 'PreToolUse') {
    fs.writeFileSync(process.env.PAC_PROBE_PRE, JSON.stringify(event.tool_input))
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...event.tool_input, file_path: process.env.PAC_PROBE_DUMMY } } }))
  } else if (event.hook_event_name === 'PostToolUse') {
    fs.writeFileSync(process.env.PAC_PROBE_POST, JSON.stringify(event.tool_response))
    process.stdout.write('{}')
  }
})
