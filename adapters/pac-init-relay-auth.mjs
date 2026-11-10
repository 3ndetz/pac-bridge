import { createHash, randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

const [directory, name, ...extra] = process.argv.slice(2)
if (!directory || !isAbsolute(directory) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name || '') || extra.length) {
  throw new Error('Usage: node adapters/pac-init-relay-auth.mjs <new-absolute-directory> <pac-name>')
}
// Never overwrite existing credentials. Keep all generated values out of
// process arguments and console output; grant access using OS permissions.
await mkdir(directory, { mode: 0o700 })
const agent = randomBytes(32).toString('hex')
const source = randomBytes(32).toString('hex')
const hash = (value) => createHash('sha256').update(value).digest('hex')
await writeFile(join(directory, 'agent.token'), `${agent}\n`, { flag: 'wx', mode: 0o600 })
await writeFile(join(directory, 'source.token'), `${source}\n`, { flag: 'wx', mode: 0o600 })
await writeFile(join(directory, 'relay-auth.json'), `${JSON.stringify({ pacs: { [name]: { agentHashes: [hash(agent)], sourceHashes: [hash(source)] } } }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
process.stdout.write('Relay authorization files created. Restrict their operating-system permissions.\n')
