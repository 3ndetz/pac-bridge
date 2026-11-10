const { spawn } = require('node:child_process')
const { createInterface } = require('node:readline')

const [agent, cwd] = process.argv.slice(2)
if (!agent || !cwd) process.exit(2)
const child = spawn(process.execPath, [agent], { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
const reader = createInterface({ input: child.stdout })
const timer = setTimeout(() => { process.stderr.write('ACP probe timed out\n'); child.kill(); process.exitCode = 1 }, 60000)
let summary
child.stderr.resume()
child.on('error', () => { clearTimeout(timer); process.exitCode = 1 })
reader.on('line', (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.id === 1 && message.result) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd, mcpServers: [] } }) + '\n')
  } else if (message.id === 2) {
    if (message.error) { clearTimeout(timer); process.stderr.write(`Session creation failed: ${message.error.message}\n`); process.exitCode = 1; child.kill(); return }
    const option = message.result.configOptions?.find((entry) => entry.category === 'model')
    const models = option?.options || []
    summary = { sessionCreated: !!message.result.sessionId, modelCount: models.length }
    const chosen = models.find((model) => model.value === 'sonnet') || models[0]
    if (!option?.id || !chosen) { clearTimeout(timer); process.stderr.write('No selectable model returned\n'); process.exitCode = 1; child.kill(); return }
    summary.requestedModel = chosen.value
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'session/set_config_option', params: { sessionId: message.result.sessionId, configId: option.id, value: chosen.value } }) + '\n')
  } else if (message.id === 3) {
    clearTimeout(timer)
    if (message.error) { process.stderr.write(`Model selection failed: ${message.error.message}\n`); process.exitCode = 1 }
    else {
      summary.confirmedModel = message.result.configOptions?.find((entry) => entry.category === 'model')?.currentValue
      process.stdout.write(JSON.stringify(summary) + '\n')
      if (summary.confirmedModel !== summary.requestedModel) process.exitCode = 1
    }
    child.kill()
  }
})
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } }) + '\n')
