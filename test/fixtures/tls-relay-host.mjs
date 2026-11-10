import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { attachAcpRelay } from '../../src/acp-relay.mjs'

const config = JSON.parse(readFileSync(process.env.PAC_TEST_TOKENS, 'utf8'))
const server = createServer({ key: readFileSync(process.env.PAC_TEST_KEY), cert: readFileSync(process.env.PAC_TEST_CERT) })
attachAcpRelay(server, { authorize: ({ role, name, token }) => {
  const hash = createHash('sha256').update(token).digest('hex')
  return ['testpac', 'testpac2', 'testmcp'].includes(name) && hash === (role === 'source' ? config.sourceHash : config.agentHash)
} })
server.listen(Number(process.env.PAC_TEST_PORT), '0.0.0.0', () => process.stdout.write(`TLS relay ready ${server.address().port} ${process.pid}\n`))
