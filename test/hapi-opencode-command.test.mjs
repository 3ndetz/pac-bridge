import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

test('HAPI command forwards native version probes and requires an explicit executable', async () => {
  const adapter = fileURLToPath(new URL('../adapters/pac-hapi-opencode.mjs', import.meta.url))
  async function invoke(env) {
    const child = spawn(process.execPath, [adapter, '--version'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk }); child.stderr.on('data', (chunk) => { output += chunk })
    const [code] = await once(child, 'close')
    return { code, output }
  }
  const ok = await invoke({ ...process.env, PAC_OPENCODE_BINARY: process.execPath })
  assert.equal(ok.code, 0)
  assert.match(ok.output, /^v\d+\./)
  const absent = await invoke({ ...process.env, PAC_OPENCODE_BINARY: '' })
  assert.notEqual(absent.code, 0)
  assert.match(absent.output, /PAC_OPENCODE_BINARY/)
})

test('installs a separate HAPI command and refuses to overwrite it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-hapi-install-'))
  const directory = join(root, 'command with spaces')
  const installer = fileURLToPath(new URL('../adapters/install-hapi-command.mjs', import.meta.url))
  const execute = async (command, args, env = process.env, windowsVerbatimArguments = false) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk }); child.stderr.on('data', (chunk) => { output += chunk })
    const [code] = await once(child, 'close')
    return { code, output }
  }
  try {
    assert.equal((await execute(process.execPath, [installer, directory])).code, 0)
    assert.notEqual((await execute(process.execPath, [installer, directory])).code, 0)
    const wrapper = join(directory, process.platform === 'win32' ? 'opencode.cmd' : 'opencode')
    const result = process.platform === 'win32'
      ? await execute(process.env.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', `""${wrapper}" --version"`], { ...process.env, PAC_OPENCODE_BINARY: process.execPath }, true)
      : await execute(wrapper, ['--version'], { ...process.env, PAC_OPENCODE_BINARY: process.execPath })
    assert.equal(result.code, 0, result.output)
    assert.match(result.output, /^v\d+\./)
  } finally { await rm(root, { recursive: true, force: true }) }
})
