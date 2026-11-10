import { readFile } from 'node:fs/promises'
import { connectSource } from '../src/acp-transport.mjs'

const [name, url, tokenFile] = process.argv.slice(2)
if (!name || !url || !tokenFile) {
  process.stderr.write('Usage: node adapters/pac-acp-source.mjs <pac-name> <relay-url> <token-file>\n')
  process.exit(2)
}

try {
  const token = (await readFile(tokenFile, 'utf8')).trim()
  const stream = await connectSource({ url, name, token })
  stream.on('error', (error) => { process.stderr.write(`PAC relay failed: ${error.message}\n`); process.exitCode = 1 })
  process.stdin.pipe(stream)
  stream.pipe(process.stdout)
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stream.destroy(); process.exit(1) })
} catch (error) {
  process.stderr.write(`PAC source startup failed: ${error.message}\n`)
  process.exitCode = 1
}
