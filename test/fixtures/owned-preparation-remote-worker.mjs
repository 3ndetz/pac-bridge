import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, writeFile, copyFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd(), mode = process.argv[2], quote = value => "'" + value.replaceAll("'", "''") + "'"
const hang = () => new Promise(() => { setInterval(() => {}, 1000) })
const mark = async label => { await writeFile(join(root, 'phase.tmp'), label); const { rename } = await import('node:fs/promises'); await rename(join(root, 'phase.tmp'), join(root, 'phase')) }
const run = async command => {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, stdio: 'ignore' })
  const [code] = await once(child, 'close')
  if (code !== 0) throw new Error('Synthetic operation failed')
}
await mkdir(join(root, 'input'))
await writeFile(join(root, 'input', 'sample.txt'), 'synthetic')
await mark('stage-boundary')
if (mode === 'stage-boundary') await hang()
await copyFile(join(root, 'input', 'sample.txt'), join(root, 'staged.txt'))
await run(`Compress-Archive -LiteralPath ${quote(join(root, 'staged.txt'))} -DestinationPath ${quote(join(root, 'input.zip'))}`)
await mark('extract-boundary')
if (mode === 'extract-boundary') await hang()
if (mode === 'extract-running') {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `while ($true) { Expand-Archive -Force -LiteralPath ${quote(join(root, 'input.zip'))} -DestinationPath ${quote(join(root, 'extracted'))}; [IO.File]::WriteAllText(${quote(join(root, 'phase'))}, 'extract-running') }`], { windowsHide: true, stdio: 'ignore' })
  await once(child, 'close')
} else await run(`Expand-Archive -LiteralPath ${quote(join(root, 'input.zip'))} -DestinationPath ${quote(join(root, 'extracted'))}`)
await mark('hash-boundary')
if (mode === 'hash-boundary') await hang()
if (mode === 'hash-running') {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `while ($true) { Get-FileHash -Algorithm SHA256 -LiteralPath ${quote(join(root, 'extracted', 'staged.txt'))} | Out-Null; [IO.File]::WriteAllText(${quote(join(root, 'phase'))}, 'hash-running') }`], { windowsHide: true, stdio: 'ignore' })
  await once(child, 'close')
}
