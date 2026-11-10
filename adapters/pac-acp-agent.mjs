import { readFile } from 'node:fs/promises'
import { startAgent } from '../src/acp-transport.mjs'
import { startSupervisedAgent } from '../src/supervised-agent.mjs'

const [name, url, tokenFile, command, ...args] = process.argv.slice(2)
if (!name || !url || !tokenFile || !command) {
  process.stderr.write('Usage: node adapters/pac-acp-agent.mjs <pac-name> <relay-url> <token-file> <agent-executable> [args...]\n')
  process.exit(2)
}

try {
  const configuration = { url, name, command, args, onError: (error) => process.stderr.write(`${error.message}\n`) }
  const readToken = async () => (await readFile(tokenFile, 'utf8')).trim()
  const agent = process.env.PAC_AGENT_RECONNECT === '1'
    ? await startSupervisedAgent({ ...configuration, tokenProvider: readToken })
    : await startAgent({ ...configuration, token: await readToken() })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { agent.close(); process.exit(0) })
} catch (error) {
  process.stderr.write(`PAC agent startup failed: ${error.message}\n`)
  process.exitCode = 1
}
