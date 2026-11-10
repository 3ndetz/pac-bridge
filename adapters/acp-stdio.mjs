import { spawn } from 'node:child_process'

const args = process.argv.slice(2)
const command = args[0] === 'omp' ? (process.env.PAC_OMP_BIN || 'omp') : args[0]
const commandArgs = args[0] === 'omp' ? ['acp', ...args.slice(1)] : args.slice(1)

if (!command) {
  process.stderr.write('Usage: node adapters/acp-stdio.mjs omp [arguments...]\n       node adapters/acp-stdio.mjs <executable> [arguments...]\n')
  process.exit(2)
}

const child = spawn(command, commandArgs, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
let finished = false

child.on('error', (error) => {
  finished = true
  process.stderr.write(`ACP adapter could not start its harness: ${error.message}\n`)
  process.exitCode = 1
})

child.on('close', (code, signal) => {
  finished = true
  process.exitCode = code ?? (signal ? 1 : 0)
})

child.stdin.on('error', (error) => {
  if (error.code !== 'EPIPE') process.stderr.write(`ACP adapter input error: ${error.message}\n`)
})
process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') {
    if (!finished) child.kill()
  } else {
    process.stderr.write(`ACP adapter output error: ${error.message}\n`)
    process.exitCode = 1
    if (!finished) child.kill()
  }
})

process.stdin.pipe(child.stdin)
child.stdout.pipe(process.stdout)
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { if (!finished) child.kill(signal) })
}
