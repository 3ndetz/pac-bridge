// Issue the tokens for a new bridge client, the one thing done by hand every time one is added.
//
//   node tokens.mjs add-client <name>
//
// Writes, under PAC_SECRETS (bridge.env):  <name>.token        the client's token (goes into the
//                                                              client's environment)
//                                          brain-<name>.token  a brain token scoped to this client
// and adds both hashes to tokens.json under PAC_TOKENS_DIR (.env), which the bridge re-reads on
// every check, so the new client can connect at once. Tokens are never printed.
//
// A lifehack over a file anyone may edit by hand: tokens.json is plain JSON of sha256 hashes.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const readEnv = (f) => {
  const out = {}
  try {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const m = /^\s*([A-Z_]+)=(.*)$/.exec(line)
      if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, '$1').replace(/\$BRIDGE_DIR/g, HERE)
    }
  } catch {}
  return out
}
const conf = { ...readEnv(path.join(HERE, 'bridge.env')), ...readEnv(path.join(HERE, '.env')), ...process.env }
const SECRETS = path.resolve(HERE, conf.PAC_SECRETS || './secrets')
const TOKENS_DIR = path.resolve(HERE, conf.PAC_TOKENS_DIR || './secrets')

const [cmd, name] = process.argv.slice(2)
if (cmd !== 'add-client' || !/^[A-Za-z0-9._-]+$/.test(name || '')) {
  console.error('usage: node tokens.mjs add-client <name>   (letters, digits, dot, dash, underscore)')
  process.exit(2)
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
const tokFile = path.join(TOKENS_DIR, 'tokens.json')
let t = { clients: {}, brains: {} }
try { t = JSON.parse(fs.readFileSync(tokFile, 'utf8')) } catch {}
if (Array.isArray(t.brains)) t.brains = Object.fromEntries(t.brains.map((h) => [h, '*']))
if (t.clients[name]) { console.error(`client ${name} already exists in ${tokFile}`); process.exit(1) }

fs.mkdirSync(SECRETS, { recursive: true })
fs.mkdirSync(TOKENS_DIR, { recursive: true })
const client = crypto.randomBytes(32).toString('base64url')
const brain = crypto.randomBytes(32).toString('base64url')
fs.writeFileSync(path.join(SECRETS, `${name}.token`), client, { mode: 0o600 })
fs.writeFileSync(path.join(SECRETS, `brain-${name}.token`), brain, { mode: 0o600 })
t.clients[name] = sha(client)
t.brains[sha(brain)] = [name]
fs.writeFileSync(tokFile, JSON.stringify(t, null, 1))
console.log(`client ${name}: tokens in ${SECRETS}, hashes in ${tokFile}`)
