import { spawnContained, stopContained } from '../src/spawn-contained.mjs'
import { accessSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { isHapiModelProbe } from '../src/acp-probe-detection.mjs'

// HAPI invokes `opencode acp`; other commands, including its version probe,
// must continue to reach the actual OpenCode executable.
const binary = process.env.PAC_OPENCODE_BINARY
if (!binary || !isAbsolute(binary)) throw new Error('PAC_OPENCODE_BINARY must point to the native OpenCode executable by absolute path')
if (process.argv[2] === 'acp') {
  if (process.env.PAC_EXPERIMENTAL !== '1') throw new Error('PAC_EXPERIMENTAL=1 is required')
  if (!process.env.PAC_SOURCE_BASH) {
    const candidates = process.platform === 'win32'
      ? [process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
          process.env.ProgramFiles && join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe')]
      : ['/bin/bash', '/usr/bin/bash']
    for (const candidate of candidates.filter(Boolean)) {
      try { accessSync(candidate); process.env.PAC_SOURCE_BASH = candidate; break } catch {}
    }
  }
  for (const name of ['PAC_EXPERIMENTAL_HOOKS', 'PAC_EXPERIMENTAL_SKILLS', 'PAC_EXPERIMENTAL_INSTRUCTIONS']) process.env[name] ??= '1'
  if (process.env.PAC_HAPI_PROVIDER_EXPERIMENT === '1') {
    if (await isHapiModelProbe(process.stdin)) {
      const { startHapiModelProbe } = await import('../src/hapi-model-probe.mjs')
      startHapiModelProbe({ input: process.stdin, output: process.stdout, binary })
    } else await import('./opencode-pac.mjs')
  } else await import('./pac-opencode-router.mjs')
} else {
  const child = spawnContained(binary, process.argv.slice(2), { stdio: 'inherit', windowsHide: false,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY) })
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stopContained(child))
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolve(code ?? 1))
  })
}
