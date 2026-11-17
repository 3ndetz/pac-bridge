import { mkdir, writeFile, copyFile, readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const root = process.cwd(), phase = process.argv[2]
const run = promisify(execFile)
const hang = () => new Promise(() => { setInterval(() => {}, 1000) })
await mkdir(join(root, 'input'))
await writeFile(join(root, 'input', 'sample.txt'), 'synthetic')
await writeFile(join(root, 'phase'), 'stage')
if (phase === 'stage') await hang()
await copyFile(join(root, 'input', 'sample.txt'), join(root, 'staged.txt'))
const quote = value => "'" + value.replaceAll("'", "''") + "'"
await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Compress-Archive -LiteralPath ${quote(join(root, 'staged.txt'))} -DestinationPath ${quote(join(root, 'input.zip'))}`], { windowsHide: true, timeout: 15000 })
await writeFile(join(root, 'phase'), 'extract')
if (phase === 'extract') await hang()
await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${quote(join(root, 'input.zip'))} -DestinationPath ${quote(join(root, 'extracted'))}`], { windowsHide: true, timeout: 15000 })
await writeFile(join(root, 'phase'), 'hash')
if (phase === 'hash') await hang()
const hash = createHash('sha256').update(await readFile(join(root, 'extracted', 'staged.txt'))).digest('hex')
await writeFile(join(root, 'result'), hash)
