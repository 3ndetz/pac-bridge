import { readFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { attachAcpRelay } from '../src/acp-relay.mjs'
import { createRelayAuthorizer } from '../src/relay-auth.mjs'

const host = process.env.PAC_RELAY_HOST || '127.0.0.1'
const port = Number(process.env.PAC_RELAY_PORT || '8791')
const keyPath = process.env.PAC_RELAY_TLS_KEY
const certPath = process.env.PAC_RELAY_TLS_CERT
if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || Boolean(keyPath) !== Boolean(certPath) ||
    (!keyPath && !['127.0.0.1', '::1', 'localhost'].includes(host))) throw new Error('Invalid relay listener configuration')
const authorize = createRelayAuthorizer(process.env.PAC_RELAY_AUTH_FILE)
const handler = (request, response) => {
  if (request.method === 'GET' && request.url === '/healthz') response.writeHead(200, { 'content-type': 'text/plain' }).end('ok\n')
  else response.writeHead(404).end()
}
const server = keyPath ? createHttpsServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, handler) : createHttpServer(handler)
const relay = attachAcpRelay(server, { authorize })
server.listen(port, host, () => process.stderr.write('PAC relay listening\n'))
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { relay.close(); server.close() })
