import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [directory, option, ...extra] = process.argv.slice(2)
if (!directory || !isAbsolute(directory) || extra.length || (option !== undefined && option !== '--provider-dispatch')) throw new Error('Usage: node adapters/install-hapi-command.mjs <new-absolute-directory> [--provider-dispatch]')
const command = fileURLToPath(new URL(option === '--provider-dispatch' ? './provider-dispatch.mjs' : './pac-hapi-opencode.mjs', import.meta.url))
const node = process.execPath
let name, body
if (process.platform === 'win32') {
  if ([node, command].some((path) => /["%!\r\n]/.test(path))) throw new Error('Unsupported executable path for Windows command wrapper')
  name = 'opencode.cmd'
  body = `@echo off\r\n"${node}" "${command}" %*\r\nexit /b %ERRORLEVEL%\r\n`
} else {
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
  name = 'opencode'
  body = `#!/bin/sh\nexec ${quote(node)} ${quote(command)} "$@"\n`
}
// Require a new directory so an existing OpenCode command is never replaced.
await mkdir(directory, { mode: 0o700 })
await writeFile(join(directory, name), body, { flag: 'wx', mode: 0o755 })
process.stdout.write(`Created ${name} in the requested directory. Configure the HAPI runner environment before use.\n`)
